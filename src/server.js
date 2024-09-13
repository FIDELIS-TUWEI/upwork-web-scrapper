require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const { MongoClient } = require("mongodb");
const rateLimit = require("axios-rate-limit");

const UPWORK_URL = 'https://www.upwork.com/nx/jobs/search/?q=web%20developer';
const TAGS_TO_WATCH = ['Fullstack developer', 'Nextjs developer', 'React developer', 'MERN developer'];
const YOUR_EMAIL = process.env.YOUR_EMAIL

// rate-limited axios instance
const http = rateLimit(axios.create(), { maxRequests: 1, perMilliseconds: 60000 });

// Email configuration
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    requireTLS: true,
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// MongoDB setup 
const mongoClient = new MongoClient(process.env.MONGODB_URI);
let jobsCollection;

async function connectToDatabase() {
    try {
        await mongoClient.connect();
        const db = mongoClient.db('upwork_scraper');
        jobsCollection = db.collection('jobs');
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        process.exit(1);
    }
}

async function scrapeUpworkJobs() {
    try {
        const response = await http.get(UPWORK_URL, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        });
        const $ = cheerio.load(response.data);
        const jobs = [];

        $('.up-card-section').each((index, element) => {
        const title = $(element).find('h3[data-test="job-title"]').text().trim();
        const link = 'https://www.upwork.com' + $(element).find('h3[data-test="job-title"] a').attr('href');
        const jobId = link.split('~')[1];
        const skills = $(element).find('span[data-test="attr-item"]').map((i, el) => $(el).text().trim()).get();

        if (skills.some(skill => TAGS_TO_WATCH.includes(skill))) {
            jobs.push({ jobId, title, link, skills });
        }
        });

        return jobs;
    } catch (error) {
        console.error('Error scraping Upwork:', error);
        return [];
    }
}

async function filterNewJobs(jobs) {
    const newJobs = [];
    for (const job of jobs) {
        const existingJob = await jobsCollection.findOne({ jobId: job.jobId });
        if (!existingJob) {
        await jobsCollection.insertOne(job);
        newJobs.push(job);
        }
    }
    return newJobs;
}

async function sendEmailNotification(jobs) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: YOUR_EMAIL,
        subject: 'New Upwork Jobs Alert',
        html: `
        <h1>New Upwork Jobs Matching Your Criteria</h1>
        ${jobs.map(job => `
            <div>
            <h2>${job.title}</h2>
            <p>Skills: ${job.skills.join(', ')}</p>
            <a href="${job.link}">View Job</a>
            </div>
            <hr>
        `).join('')}
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Email notification sent successfully');
    } catch (error) {
        console.error('Error sending email notification:', error);
    }
}

async function checkForNewJobs() {
    console.log('Checking for new jobs...');
    try {
        const scrapedJobs = await scrapeUpworkJobs();
        const newJobs = await filterNewJobs(scrapedJobs);
        if (newJobs.length > 0) {
        console.log(`Found ${newJobs.length} new job(s)`);
        await sendEmailNotification(newJobs);
        } else {
        console.log('No new jobs found');
        }
    } catch (error) {
        console.error('Error checking for new jobs:', error);
    }
}

async function main() {
    await connectToDatabase();

    // Run the job check every 30 minutes
    cron.schedule('*/30 * * * *', checkForNewJobs);

    console.log('Upwork job scraper is running. Checking for new jobs every 30 minutes.');

    // Initial check
    await checkForNewJobs();
}

main().catch(console.error);

process.on('SIGINT', async () => {
    console.log('Closing MongoDB connection');
    await mongoClient.close();
    process.exit(0);
});