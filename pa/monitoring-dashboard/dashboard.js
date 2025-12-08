import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bodyParser from 'body-parser';
import { exec, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import http from 'http';

///// if you want to change Auto refresh value, then find this  "startAutoRefreshWithHealing(60);" and change it  to whatever value you want
//// and inside of the index.html  look for this value and change first "60" to whatever number you desire. it is looks like this "const refreshInterval = 30 * 60 * 1000; "
/// change this value for cooldown minutes for sending email "cooldownMinutes "

// ES module __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const DASHBOARD_PORT = 3003;

// Paths
const RADIO_SH = '/home/serveradmin/pa/pa.sh';
const LINPHONERC = '/home/serveradmin/pa/linphonerc';
const RADIO_LOG = '/home/serveradmin/pa/pa.log';
const STATUS_FILE = path.join(__dirname, 'status.json');
const CHECK_SCRIPT = '/home/serveradmin/pa/check.sh';
const ALERT_HISTORY_FILE = path.join(__dirname, 'alert_history.json');

// SMTP Configuration
const SMTP_CONFIG = {
  host: 'ydpsmtp01.admin.drakefoodmarkets.com.au',
  port: 25,
  secure: false, // false for port 25
  auth: {
    user: 'hossein.abedinzadeh@drakes.com.au',
    pass: '' // No password needed
  },
  from: 'pa-monitoring@drakes.com.au',
  to: 'hossein.abedinzadeh@drakes.com.au'
};

// Global variables
let autoHealEnabled = true;
let autoHealTimer = null;
let secondHealTimer = null;
let alertHistory = {};

// Create necessary directories on startup
const healLogsDir = path.join(__dirname, 'heal_logs');
if (!fs.existsSync(healLogsDir)) {
  fs.mkdirSync(healLogsDir, { recursive: true });
  console.log('✅ Created heal_logs directory');
}

// Load alert history
function loadAlertHistory() {
  try {
    if (fs.existsSync(ALERT_HISTORY_FILE)) {
      const data = fs.readFileSync(ALERT_HISTORY_FILE, 'utf-8');
      alertHistory = JSON.parse(data);
    }
  } catch (error) {
    console.error('❌ Error loading alert history:', error);
    alertHistory = {};
  }
}

// Save alert history
function saveAlertHistory() {
  try {
    fs.writeFileSync(ALERT_HISTORY_FILE, JSON.stringify(alertHistory, null, 2));
  } catch (error) {
    console.error('❌ Error saving alert history:', error);
  }
}

// Initialize alert history
loadAlertHistory();

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------
// Email Alert Functions
// ------------------------

// Create email transporter - FIXED: createTransport (not createTransporter)
const emailTransporter = nodemailer.createTransport({
  host: SMTP_CONFIG.host,
  port: SMTP_CONFIG.port,
  secure: SMTP_CONFIG.secure,
  auth: SMTP_CONFIG.auth,
  tls: {
    rejectUnauthorized: false // For internal SMTP servers
  }
});

// Test email connection on startup
emailTransporter.verify((error, success) => {
  if (error) {
    console.error('❌ Email transporter verification failed:', error);
  } else {
    console.log('✅ Email transporter ready');
  }
});

// Generate alert key for deduplication
function generateAlertKey(serverIp, alertType, details = '') {
  return `${serverIp}_${alertType}_${details}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

// Check if alert was recently sent (avoid spam)
function shouldSendAlert(alertKey, cooldownMinutes = 1) {
  const now = Date.now();
  const lastSent = alertHistory[alertKey];
  
  if (!lastSent) return true;
  
  const minutesSinceLastAlert = (now - lastSent) / (1000 * 60);
  return minutesSinceLastAlert >= cooldownMinutes;
}

// Update alert history
function updateAlertHistory(alertKey) {
  alertHistory[alertKey] = Date.now();
  saveAlertHistory();
}

// Send email alert
async function sendEmailAlert(subject, message, server = null, status = null) {
  try {
    // Determine alert type
    let isSuccess = status === 'ok' || subject.toLowerCase().includes('recover') || subject.toLowerCase().includes('recovered');
    let isInfo = subject.toLowerCase().includes('new server');

    // Colors for different alert types
    let borderColor, backgroundColor, textColor;

    if (isSuccess) {
      borderColor = '#28a745';
      backgroundColor = '#d4edda';
      textColor = '#155724';
    } else if (isInfo) {
      borderColor = '#17a2b8';
      backgroundColor = '#d1ecf1';
      textColor = '#0c5460';
    } else {
      borderColor = '#dc3545';
      backgroundColor = '#f8d7da';
      textColor = '#721c24';
    }

    // Create a clean server object without the log for display
    let cleanServer = null;
    if (server) {
      cleanServer = {
        name: server.name,
        ip: server.ip,
        status: server.status
        // Don't include the log property
      };
    }

    const htmlMessage = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          /* Reset for email clients */
          body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
          /* Outlook-specific fixes */
          table { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
        </style>
        <!--[if mso]>
        <style>
          .alert-container { background-color: ${backgroundColor} !important; }
        </style>
        <![endif]-->
      </head>
      <body>
        <h2 style="color: #343a40; margin-bottom: 20px;">${subject}</h2>

        ${cleanServer ? `
        <div style="background: #e9ecef; padding: 15px; border-radius: 6px; margin: 15px 0; border-left: 4px solid #6c757d;">
          <strong style="color: #495057;">Server:</strong> ${cleanServer.name} (${cleanServer.ip})<br>
          <strong style="color: #495057;">Status:</strong> ${cleanServer.status}
        </div>
        ` : ''}

        <!-- Use table for Outlook compatibility -->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td style="border-left: 6px solid ${borderColor}; padding: 20px; background: ${backgroundColor}; color: ${textColor}; border-radius: 0 8px 8px 0;">
              ${message.replace(/\n/g, '<br>')}
            </td>
          </tr>
        </table>

        <p style="color: #6c757d; font-size: 12px; margin-top: 20px; font-style: italic;">
          PA Monitoring System - ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' })}
        </p>
      </body>
      </html>
    `;

    const mailOptions = {
      from: SMTP_CONFIG.from,
      to: SMTP_CONFIG.to,
      subject: `PA Monitoring Alert: ${subject}`,
      html: htmlMessage,
      // Important for Outlook
      headers: {
        'X-Mailer': 'PA Monitoring System',
        'Content-Type': 'text/html; charset=UTF-8'
      }
    };

    const result = await emailTransporter.sendMail(mailOptions);
    console.log(`✅ Email alert sent: ${subject} (${isSuccess ? 'SUCCESS-GREEN' : 'FAILURE-RED'})`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('❌ Failed to send email alert:', error);
    return { success: false, error: error.message };
  }
}

// Monitor server status changes and send alerts
async function monitorServerStatusChanges(oldServers, newServers) {
  console.log('🔍 DEBUG: Starting status change monitoring...');

  if (!oldServers || !newServers) {
    console.log('❌ DEBUG: No old or new servers to compare');
    return;
  }

  console.log(`🔍 DEBUG: Comparing ${oldServers.length} old vs ${newServers.length} new servers`);

  // Create maps for easier lookup
  const oldServerMap = new Map();
  const newServerMap = new Map();

  oldServers.forEach(server => oldServerMap.set(server.ip, server));
  newServers.forEach(server => newServerMap.set(server.ip, server));

  // Track all unique IPs from both arrays
  const allIps = new Set([
    ...oldServers.map(s => s.ip),
    ...newServers.map(s => s.ip)
  ]);

  console.log(`🔍 DEBUG: Processing ${allIps.size} unique servers`);

  for (const ip of allIps) {
    const oldServer = oldServerMap.get(ip);
    const newServer = newServerMap.get(ip);

    // Case 1: Server exists in both arrays - check for ACTUAL status changes only
    if (oldServer && newServer) {
      // Only send alerts for actual status changes (ok→fail or fail→ok)
      // Ignore when status remains the same but other fields change
      if (oldServer.status !== newServer.status) {
        console.log(`🔄 DEBUG: REAL STATUS CHANGE DETECTED for ${ip}: "${oldServer.status}" → "${newServer.status}"`);
        const alertKey = generateAlertKey(ip, 'status_change', newServer.status);

        if (shouldSendAlert(alertKey)) {
          let subject = '';
          let message = '';

          if (newServer.status === 'fail' || newServer.status === 'error') {
            subject = `Server Failure: ${newServer.name}`;
            message = `Server ${newServer.name} (${newServer.ip}) is now FAILING\n\n` +
                     `Previous Status: ${oldServer.status}\n` +
                     `Current Status: ${newServer.status}\n` +
                     `Failure Time: ${new Date().toLocaleString('en-AU', {
                       timeZone: 'Australia/Adelaide',
                       year: 'numeric',
                       month: '2-digit',
                       day: '2-digit',
                       hour: '2-digit',
                       minute: '2-digit',
                       second: '2-digit',
                       hour12: false
                     })} (ACDT)`;
          } else if (newServer.status === 'ok') {
            subject = `Server Recovered: ${newServer.name}`;
            message = `Server ${newServer.name} (${newServer.ip}) has RECOVERED and is now healthy!\n\n` +
                     `Previous Status: ${oldServer.status}\n` +
                     `Current Status: ${newServer.status}\n` +
                     `Recovery Time: ${new Date().toLocaleString('en-AU', {
                       timeZone: 'Australia/Adelaide',
                       year: 'numeric',
                       month: '2-digit',
                       day: '2-digit',
                       hour: '2-digit',
                       minute: '2-digit',
                       second: '2-digit',
                       hour12: false
                     })} (ACDT)`;
          }

          if (subject && message) {
            const emailStatus = (newServer.status === 'ok') ? 'ok' : 'fail';
            await sendEmailAlert(subject, message, newServer, emailStatus);
            updateAlertHistory(alertKey);
            console.log(`📧 DEBUG: Sent ${emailStatus.toUpperCase()} alert for ${ip}`);
          }
        }
      } else {
        // Status is the same, but log if other fields changed (for debugging)
        const healingFieldsChanged = ['firstPulseAudio', 'firstContainer', 'secondPulseAudio', 'secondContainer', 'log'].some(field => 
          oldServer[field] !== newServer[field]
        );
        
        if (healingFieldsChanged) {
          console.log(`➡️ DEBUG: No status change for ${ip} (still "${oldServer.status}"), but healing fields updated`);
        } else {
          console.log(`➡️ DEBUG: No changes for ${ip}: "${oldServer.status}"`);
        }
      }
    }
    // Case 2: Server only exists in new array (NEW SERVER) - SKIP ALERTS
    else if (!oldServer && newServer) {
      console.log(`➡️ DEBUG: Skipping new server detection for ${ip} - no alerts for new servers`);
      continue;
    }
    // Case 3: Server only exists in old array (REMOVED SERVER)
    else if (oldServer && !newServer) {
      console.log(`🗑️ DEBUG: Server ${ip} was removed from monitoring`);
      // Optional: Send alert for removed server if needed
    }
  }

  console.log('✅ DEBUG: Status change monitoring completed');
}


// Check if healing was completed
function isHealingCompleted(oldServer, newServer) {
  // Check if any healing fields changed from in-progress to done/failed
  const healingFields = ['firstPulseAudio', 'firstContainer', 'secondPulseAudio', 'secondContainer', 'manualPulseAudio', 'manualContainer'];
  
  return healingFields.some(field => {
    const oldValue = oldServer[field];
    const newValue = newServer[field];
    return (oldValue === 'In-Progress' && (newValue === 'Done' || newValue === 'Failed')) ||
           (!oldValue && (newValue === 'Done' || newValue === 'Failed'));
  });
}

// Get healing type description
function getHealingType(oldServer, newServer) {
  if (newServer.manualPulseAudio === 'Done' || newServer.manualContainer === 'Done') return 'Manual Healing';
  if (newServer.secondPulseAudio === 'Done' || newServer.secondContainer === 'Done') return 'Second Auto-Healing Attempt';
  if (newServer.firstPulseAudio === 'Done' || newServer.firstContainer === 'Done') return 'First Auto-Healing Attempt';
  return 'Unknown Healing Type';
}

// ------------------------
// Utility Functions (keep all your existing ones)
// ------------------------

function trimLog() {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  if (!fs.existsSync(RADIO_LOG)) return;

  const now = Date.now();
  const lines = fs.readFileSync(RADIO_LOG, 'utf-8').split('\n');
  let keepIndex = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}/);
    if (match) {
      const timestamp = new Date(match[0]).getTime();
      if (now - timestamp < SEVEN_DAYS_MS) keepIndex = i;
      else break;
    }
  }

  if (keepIndex < lines.length - 1) {
    const trimmedLines = lines.slice(keepIndex);
    fs.writeFileSync(RADIO_LOG, trimmedLines.join('\n'));
  }
}

function logHealAttempt(ip, message) {
  const logFile = path.join(healLogsDir, `${ip.replace(/\./g, '-')}.log`);
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  fs.appendFileSync(logFile, logMessage);
  console.log(`📝 ${ip}: ${message}`);
}

async function callRemoteAPI(ip, endpoint, method = 'GET', data = null) {
  return new Promise((resolve) => {
    const url = `http://${ip}:3000${endpoint}`;
    console.log(`🌐 Calling remote API: ${method} ${url}`);

    let curlCommand;
    if (method === 'POST' && data) {
      const formData = Object.keys(data).map(key =>
        `${key}=${encodeURIComponent(data[key])}`
      ).join('&');

      curlCommand = `curl -X POST "${url}" -H "Content-Type: application/x-www-form-urlencoded" -d "${formData}" --connect-timeout 30 --max-time 60 -s`;
    } else {
      curlCommand = `curl -X ${method} "${url}" --connect-timeout 30 --max-time 60 -s`;
    }

    exec(curlCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ API call failed for ${ip}${endpoint}:`, error.message);
        resolve({
          success: false,
          response: `API call failed: ${error.message}`,
          error: error.message
        });
      } else {
        console.log(`✅ API call completed for ${ip}${endpoint}`);
        resolve({
          success: true,
          response: stdout || 'Success (no response body)'
        });
      }
    });
  });
}

// ------------------------
// Enhanced Self-Healing with Verification
// ------------------------
async function performHealingCycle(servers, attempt) {
  console.log(`🚀 Performing ${attempt} healing cycle on ${servers.length} servers`);

  // Read the current status to get all servers (not just failed ones)
  let allServers;
  try {
    const statusData = fs.readFileSync(STATUS_FILE, 'utf-8');
    allServers = JSON.parse(statusData);
  } catch (error) {
    console.error('❌ Error reading status file:', error);
    return;
  }

  // Store old state for monitoring changes
  const oldServers = JSON.parse(JSON.stringify(allServers));

  // Process each server sequentially with proper scoping
  for (const server of servers) {
    await healSingleServer(server, allServers, attempt);
  }

  // Monitor for status changes and send alerts
  await monitorServerStatusChanges(oldServers, allServers);
}

// New helper function to handle healing for a single server
async function healSingleServer(server, allServers, attempt) {
  console.log(`🔄 ${attempt} healing: ${server.name} (${server.ip})`);

  // Find the server in allServers to update it
  const serverToUpdate = allServers.find(s => s.ip === server.ip);
  if (!serverToUpdate) {
    console.log(`❌ Server ${server.ip} not found in status file`);
    return;
  }

  // Step 1: Restart PulseAudio via web API
  const healResult = await callRemoteAPI(server.ip, '/restart-pulse', 'POST');

  serverToUpdate[`${attempt.toLowerCase()}PulseAudio`] = healResult.success ? 'In-Progress' : 'Failed';
  serverToUpdate[`${attempt.toLowerCase()}HealTime`] = new Date().toISOString();
  serverToUpdate[`${attempt.toLowerCase()}HealDetails`] = healResult.response;

  logHealAttempt(server.ip, `${attempt}-HEAL: PulseAudio restart - ${healResult.success ? 'SUCCESS' : 'FAILED'}`);

  // If PulseAudio restart failed, skip to next server
  if (!healResult.success) {
    serverToUpdate[`${attempt.toLowerCase()}PulseAudio`] = 'Failed';
    await saveServerStatus(allServers);
    return;
  }

  // Step 2: Wait 60 seconds, then restart PA container via save API
  console.log(`⏰ Waiting 60 seconds before restarting PA container...`);
  await new Promise(resolve => setTimeout(resolve, 60000));

  console.log(`🐳 ${attempt} container restart: ${server.name} (${server.ip})`);
  const containerResult = await callRemoteAPI(server.ip, '/save', 'POST', {
    VOLUME_NORMAL: '50',
    VOLUME_CALL: '30',
    CALL_AUDIO_VOLUME: '70'
  });

  serverToUpdate[`${attempt.toLowerCase()}Container`] = containerResult.success ? 'In-Progress' : 'Failed';
  serverToUpdate[`${attempt.toLowerCase()}SaveTime`] = new Date().toISOString();
  serverToUpdate[`${attempt.toLowerCase()}SaveDetails`] = containerResult.response;

  logHealAttempt(server.ip, `${attempt}-CONTAINER: PA container restart - ${containerResult.success ? 'SUCCESS' : 'FAILED'}`);

  // If container restart failed, mark as failed and save status
  if (!containerResult.success) {
    serverToUpdate[`${attempt.toLowerCase()}Container`] = 'Failed';
    await saveServerStatus(allServers);
    return;
  }

  // Step 3: Wait 60 seconds after container restart, then verify server status
  console.log(`⏰ ${attempt} verification: Waiting 60 seconds to verify ${server.ip}...`);
  await new Promise(resolve => setTimeout(resolve, 60000));

  console.log(`🔍 ${attempt} verification: Checking server status for ${server.ip}`);
  const verificationResult = await verifyServerStatus(server.ip);

  if (verificationResult.healthy) {
    // Server is healthy - update status to "ok"
    serverToUpdate.status = 'ok';
    serverToUpdate[`${attempt.toLowerCase()}PulseAudio`] = 'Done';
    serverToUpdate[`${attempt.toLowerCase()}Container`] = 'Done';
    serverToUpdate.log = `Auto-healed successfully: ${verificationResult.log}`;
    logHealAttempt(server.ip, `${attempt}-VERIFICATION: Server is now HEALTHY - Status updated to OK`);
  } else {
    // Server still has issues
    serverToUpdate[`${attempt.toLowerCase()}PulseAudio`] = 'Failed';
    serverToUpdate[`${attempt.toLowerCase()}Container`] = 'Failed';
    serverToUpdate.log = `Healing attempted but still failing: ${verificationResult.log}`;
    logHealAttempt(server.ip, `${attempt}-VERIFICATION: Server still UNHEALTHY`);
  }

  // Save status AFTER verification is complete
  await saveServerStatus(allServers);
  console.log(`✅ ${attempt} verification completed for ${server.ip}: ${verificationResult.healthy ? 'HEALTHY' : 'UNHEALTHY'}`);
}

// ------------------------
// Enhanced Server Status Verification Function
// ------------------------
async function verifyServerStatus(ip) {
  return new Promise((resolve) => {
    console.log(`🔍 Verifying server status for ${ip}`);

    // Use check.sh in single server mode to verify status
    const verifyCommand = `bash /home/serveradmin/pa/check.sh single ${ip}`;

    exec(verifyCommand, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Verification failed for ${ip}:`, error.message);
        console.error(`stderr:`, stderr);
        resolve({
          healthy: false,
          log: `Verification command failed: ${error.message}`
        });
        return;
      }

      // Check if we got any output
      if (!stdout || stdout.trim().length === 0) {
        console.error(`❌ Verification returned no output for ${ip}`);
        resolve({
          healthy: false,
          log: `Verification failed: No output received from check command`
        });
        return;
      }

      try {
        // Parse the output to determine if server is healthy
        const isHealthy = stdout.includes('✅ OK') ||
                         stdout.includes('VERIFICATION: SUCCESS') ||
                         (stdout.includes('OK') && !stdout.includes('❌')) ||
                         stdout.toLowerCase().includes('server is healthy');

        console.log(`📊 Verification result for ${ip}:`, {
          healthy: isHealthy,
          output: stdout.substring(0, 300) // First 300 chars for logging
        });

        if (isHealthy) {
          resolve({
            healthy: true,
            log: `Server verified as healthy: ${stdout.split('\n').find(line => line.includes('✅') || line.includes('VERIFICATION')) || 'Server is running normally'}`
          });
        } else {
          resolve({
            healthy: false,
            log: `Server still has issues: ${stdout.split('\n').find(line => line.includes('❌') || line.includes('FAIL')) || 'Verification completed but server not healthy'}`
          });
        }
      } catch (parseError) {
        console.error(`❌ Verification parsing error for ${ip}:`, parseError);
        resolve({
          healthy: false,
          log: `Verification parsing error: ${parseError.message}`
        });
      }
    });
  });
}

// ------------------------
// Check for IO Error Exception
// ------------------------
function hasIOErrorInLogs(logContent) {
  if (!logContent) return false;

  // Look for "io error" in the logs (case insensitive)
  const ioErrorPattern = /io error/i;
  return ioErrorPattern.test(logContent);
}

// ------------------------
// Automated Self-Healing System
// ------------------------
async function automatedSelfHealing() {
  if (!autoHealEnabled) {
    console.log('⏸️ Auto-healing disabled');
    return;
  }

  console.log('🤖 Starting DUAL self-healing cycle...');

  try {
    // Step 1: Read current server status
    const statusData = fs.readFileSync(STATUS_FILE, 'utf-8');
    const allServers = JSON.parse(statusData);

    // Store old state for monitoring
    const oldServers = JSON.parse(JSON.stringify(allServers));

    // Filter out servers with IO errors (they need manual intervention)
    const failedServers = allServers.filter(server =>
      (server.status === 'fail' || server.status === 'error') &&
      !hasIOErrorInLogs(server.log) // Skip servers with IO errors
    );

    const ioErrorServers = allServers.filter(server =>
      hasIOErrorInLogs(server.log)
    );

    if (ioErrorServers.length > 0) {
      console.log(`🚫 Skipping ${ioErrorServers.length} servers with IO errors (need manual intervention)`);

      // Send alert for IO error servers ONLY if they're newly detected or status changed
      for (const server of ioErrorServers) {
        const alertKey = generateAlertKey(server.ip, 'io_error_skip_healing');
        
        // Check if this is a new IO error or if the server status just changed to fail
        const oldServer = oldServers.find(s => s.ip === server.ip);
        const isNewIOError = !oldServer || 
                            !hasIOErrorInLogs(oldServer.log) || 
                            oldServer.status !== server.status;
        
        if (isNewIOError && shouldSendAlert(alertKey, 60)) { // 60 minutes cooldown for IO errors
          await sendEmailAlert(
            'IO Error - Healing Skipped',
            `Server with IO/Firewall issue detected - auto-healing skipped:\n\n` +
            `Server: ${server.name} (${server.ip})\n` +
            `Status: ${server.status}\n` +
            `Issue: IO Error detected in logs\n` +
            `ACTION REQUIRED: Manual intervention needed to resolve firewall/connectivity issue.`,
            server
          );
          updateAlertHistory(alertKey);
          console.log(`📧 DEBUG: Sent IO error alert for ${server.ip}`);
        } else {
          console.log(`➡️ DEBUG: Skipping IO error alert for ${server.ip} - already notified`);
        }
      }
    }

    console.log(`🔧 Found ${failedServers.length} servers for FIRST healing attempt`);

    // FIRST HEALING ATTEMPT: Immediate
    await performHealingCycle(failedServers, 'FIRST');

    // SECOND HEALING ATTEMPT: After 10 minutes
    console.log('⏰ Scheduling SECOND healing attempt in 10 minutes...');

    if (secondHealTimer) {
      clearTimeout(secondHealTimer);
    }

    secondHealTimer = setTimeout(async () => {
      console.log('🔄 Starting SECOND healing attempt...');

      // Re-read status to get current failed servers
      const currentStatus = fs.readFileSync(STATUS_FILE, 'utf-8');
      const currentServers = JSON.parse(currentStatus);

      const stillFailedServers = currentServers.filter(server =>
        server.status === 'fail' || server.status === 'error'
      );

      console.log(`🔧 Found ${stillFailedServers.length} servers for SECOND healing attempt`);

      if (stillFailedServers.length > 0) {
        await performHealingCycle(stillFailedServers, 'SECOND');
      } else {
        console.log('✅ No failed servers found for second attempt - all healed!');
      }

    }, 10 * 60 * 1000);

  } catch (error) {
    console.error('❌ Automated self-healing failed:', error);
  }
}

// ------------------------
// Save Server Status Function
// ------------------------
async function saveServerStatus(servers) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(servers, null, 2));
    console.log('💾 Server status saved to status.json');
  } catch (error) {
    console.error('❌ Failed to save server status:', error);
  }
}

// ------------------------
// Auto-Refresh System (60 minutes)
// ------------------------
function startAutoRefreshWithHealing(minutes = 60) {
  console.log(`🔄 Auto-refresh with DUAL healing: ${minutes} minutes`);

  if (autoHealTimer) {
    clearInterval(autoHealTimer);
  }

  autoHealTimer = setInterval(() => {
    console.log(`🔄 Auto-refresh triggered with DUAL healing (${minutes} min interval)`);

    fetch(`http://localhost:${DASHBOARD_PORT}/refresh-now`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        console.log('✅ Auto-refresh completed:', data.message);
      })
      .catch(err => {
        console.error('❌ Auto-refresh failed:', err);
      });

  }, minutes * 60 * 1000);
}

// ------------------------
// API Routes
// ------------------------
app.post('/test-alert', express.json(), async (req, res) => {
  const { alertType, serverIp } = req.body;

  try {
    let subject, message, server = null;

    if (serverIp) {
      const statusData = fs.readFileSync(STATUS_FILE, 'utf-8');
      const servers = JSON.parse(statusData);
      server = servers.find(s => s.ip === serverIp);
    }

    switch (alertType) {
      case 'failure':
        subject = 'Test Alert: Server Failure';
        message = 'This is a test alert for server failure scenario.';
        break;
      case 'recovery':
        subject = 'Test Alert: Server Recovery';
        message = 'This is a test alert for server recovery scenario.';
        break;
      case 'firewall':
        subject = 'Test Alert: Firewall Exception';
        message = 'This is a test alert for firewall/IO exception scenario.';
        break;
      case 'healing':
        subject = 'Test Alert: Healing Completed';
        message = 'This is a test alert for healing completion scenario.';
        break;
      default:
        subject = 'Test Alert: General Notification';
        message = 'This is a general test alert.';
    }

    const result = await sendEmailAlert(subject, message, server);
    
    if (result.success) {
      res.json({ success: true, message: 'Test alert sent successfully' });
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('❌ Test alert error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add this new endpoint to get alert history
app.get('/alert-history', (req, res) => {
  try {
    const historyWithDetails = Object.entries(alertHistory).map(([key, timestamp]) => {
      const [ip, alertType, details] = key.split('_');
      return {
        key,
        ip,
        alertType,
        details: details || '',
        timestamp: new Date(timestamp).toISOString(),
        humanTime: new Date(timestamp).toLocaleString()
      };
    }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json(historyWithDetails);
  } catch (error) {
    console.error('❌ Error getting alert history:', error);
    res.status(500).json({ error: error.message });
  }
});


// ------------------------
// Original API Routes (MISSING - ADD THESE)
// ------------------------

app.get('/status', (req, res) => {
  try {
    const radioRunning = execSync('docker inspect -f "{{.State.Running}}" pa').toString().trim();
    const pulseStatus = execSync('systemctl is-active pulseaudio.service').toString().trim();
    res.json({
      radio: radioRunning === 'true',
      pulse: pulseStatus === 'active',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Cannot get server status', details: err.message });
  }
});

app.get('/server-status', (req, res) => {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const statusData = fs.readFileSync(STATUS_FILE, 'utf-8');
      const servers = JSON.parse(statusData);

      const enhancedServers = servers.map(server => ({
        ...server,
        firstHealingStatus: server.firstPulseAudio || 'Not Attempted',
        firstHealTime: server.firstHealTime || null,
        firstSaveStatus: server.firstContainer || 'Not Attempted',
        firstSaveTime: server.firstSaveTime || null,
        secondHealingStatus: server.secondPulseAudio || 'Not Attempted',
        secondHealTime: server.secondHealTime || null,
        secondSaveStatus: server.secondContainer || 'Not Attempted',
        secondSaveTime: server.secondSaveTime || null
      }));

      console.log(`📊 Serving ${enhancedServers.length} servers with dual healing info`);
      res.json(enhancedServers);
    } else {
      console.log('⚠️ status.json not found - serving empty array');
      res.json([]);
    }
  } catch (error) {
    console.error('❌ Error reading server status:', error.message);
    res.status(500).json([{
      name: 'Error',
      ip: '0.0.0.0',
      status: 'error',
      log: 'Failed to load server status: ' + error.message,
      timestamp: new Date().toISOString()
    }]);
  }
});

app.post('/refresh-now', (req, res) => {
  try {
    console.log('🎯 Triggering status check refresh with DUAL healing...');

    // Read current status BEFORE running check to compare later
    let oldServers = [];
    if (fs.existsSync(STATUS_FILE)) {
      const oldStatusData = fs.readFileSync(STATUS_FILE, 'utf-8');
      oldServers = JSON.parse(oldStatusData);
      console.log(`📚 DEBUG: Captured ${oldServers.length} old servers for comparison`);
    } else {
      console.log('⚠️ No existing status file - first run?');
    }

    exec(`bash ${CHECK_SCRIPT}`, (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Check script failed:', error);
        return res.json({ success: false, error: error.message });
      }

      console.log('✅ Status check completed');

      // Wait a bit for the status file to be updated, then monitor changes
      setTimeout(async () => {
        // Read new status after check
        if (fs.existsSync(STATUS_FILE)) {
          const newStatusData = fs.readFileSync(STATUS_FILE, 'utf-8');
          const newServers = JSON.parse(newStatusData);
          console.log(`📚 DEBUG: Captured ${newServers.length} new servers for comparison`);

          // Monitor for status changes
          await monitorServerStatusChanges(oldServers, newServers);
        } else {
          console.log('❌ No status file found after check script');
        }

        automatedSelfHealing();
      }, 5000);

      res.json({ success: true, message: 'Refresh completed, DUAL auto-healing initiated' });
    });

  } catch (error) {
    console.error('❌ Refresh error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// FIXED: Manual Healing Endpoint that updates status.json
app.post('/heal-now', express.json(), async (req, res) => {
  const { ip } = req.body;

  if (!ip) {
    return res.status(400).json({ error: 'IP address required' });
  }

  console.log(`🔧 Manual healing requested for ${ip}`);

  try {
    // Step 1: Read current status
    const statusData = fs.readFileSync(STATUS_FILE, 'utf-8');
    const allServers = JSON.parse(statusData);
    const serverToUpdate = allServers.find(s => s.ip === ip);

    if (!serverToUpdate) {
      return res.json({ success: false, error: 'Server not found in status' });
    }

    // Step 2: Perform the healing
    console.log(`🔄 Starting manual healing for ${ip}`);
    const mockServer = { name: serverToUpdate.name, ip: ip };
    await healSingleServer(mockServer, allServers, 'MANUAL');

    // Step 3: Wait for healing to complete and verify results
    console.log(`⏳ Waiting 60 seconds for healing to complete and verify...`);
    await new Promise(resolve => setTimeout(resolve, 60000));

    // Step 4: Run a final status check to verify healing worked
    console.log(`🔍 Verifying manual healing results for ${ip}`);
    const verifyCommand = `bash /home/serveradmin/pa/check.sh single ${ip}`;

    exec(verifyCommand, (verifyError, verifyStdout, verifyStderr) => {
      // Read the current status file
      const updatedStatusData = fs.readFileSync(STATUS_FILE, 'utf-8');
      const updatedServers = JSON.parse(updatedStatusData);
      const healedServer = updatedServers.find(s => s.ip === ip);

      if (!healedServer) {
        return res.json({
          success: false,
          error: 'Could not find server after healing'
        });
      }

      // Determine final status based on verification
      let finalStatus = healedServer.status;
      let finalMessage = 'Manual healing completed';

      // Always update the status.json with healing completion
      healedServer.manualPulseAudio = 'Completed';
      healedServer.manualContainer = 'Completed';
      healedServer.manualHealTime = new Date().toISOString();
      healedServer.lastHealTime = new Date().toISOString();

      if (verifyStdout && verifyStdout.includes('✅ OK')) {
        finalStatus = 'ok';
        finalMessage = 'Manual healing completed successfully - server is now healthy';
        healedServer.status = 'ok';
        healedServer.log = `Manual healing completed successfully at ${new Date().toISOString()}. Verification: Server is healthy.`;
      } else {
        finalStatus = 'fail';
        finalMessage = 'Manual healing completed but server still has issues';
        healedServer.status = 'fail';
        healedServer.log = `Manual healing completed at ${new Date().toISOString()} but server verification failed.`;
      }

      // Always save the updated status regardless of verification result
      fs.writeFileSync(STATUS_FILE, JSON.stringify(updatedServers, null, 2));
      console.log(`✅ Updated ${ip} status to '${finalStatus}' in status.json`);

      console.log(`✅ Manual healing completed for ${ip}. Final status: ${finalStatus}`);

      res.json({
        success: true,
        message: finalMessage,
        finalStatus: finalStatus,
        server: {
          ip: ip,
          name: healedServer.name,
          status: finalStatus,
          manualPulseAudio: healedServer.manualPulseAudio,
          manualContainer: healedServer.manualContainer,
          manualHealTime: healedServer.manualHealTime
        }
      });
    });

  } catch (error) {
    console.error(`❌ Manual healing error for ${ip}:`, error);
    res.json({
      success: false,
      error: error.message
    });
  }
});

app.post('/update-refresh-interval', express.json(), (req, res) => {
  const { minutes } = req.body;

  if (!minutes || minutes < 1) {
    return res.status(400).json({ error: 'Valid minutes required (minimum 1)' });
  }

  console.log(`🔄 Updating auto-refresh interval to ${minutes} minutes`);

  // Restart the auto-refresh timer with new interval
  startAutoRefreshWithHealing(minutes);

  res.json({ success: true, message: `Auto-refresh interval updated to ${minutes} minutes` });
});

// Add the missing routes that were in your original dashboard.js
app.get('/', (req, res) => {
  const config = {
    STREAM_URL: '', AUDIO_DEVICE: '', VOLUME_NORMAL: '',
    VOLUME_CALL: '', CALL_AUDIO_VOLUME: '', PHONE: '', PASSWORD: ''
  };

  try {
    const radioLines = fs.readFileSync(RADIO_SH, 'utf-8').split('\n');
    radioLines.forEach(line => {
      if (line.startsWith('STREAM_URL=')) config.STREAM_URL = line.split('=')[1].replace(/"/g, '');
      if (line.startsWith('AUDIO_DEVICE=')) config.AUDIO_DEVICE = line.split('=')[1].replace(/"/g, '');
      if (line.startsWith('VOLUME_NORMAL=')) config.VOLUME_NORMAL = line.split('=')[1];
      if (line.startsWith('VOLUME_CALL=')) config.VOLUME_CALL = line.split('=')[1];
      if (line.startsWith('CALL_AUDIO_VOLUME=')) config.CALL_AUDIO_VOLUME = line.split('=')[1];
    });

    const linphoneContent = fs.readFileSync(LINPHONERC, 'utf-8');
    const matchPhone = linphoneContent.match(/username=(.+)/);
    if (matchPhone) config.PHONE = matchPhone[1];
    const matchHa1 = linphoneContent.match(/ha1=([a-f0-9]{32})/);
    if (matchHa1) config.PASSWORD = matchHa1[1];

    config.STREAM_PLAY_URL = `http://localhost:${DASHBOARD_PORT}/live`;
  } catch (err) {
    console.error('Error reading config files:', err);
  }

  const htmlPath = path.join(__dirname, 'public/index.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  const script = `<script>window.config = ${JSON.stringify(config)};<\/script>`;
  html = html.replace('</head>', `${script}\n</head>`);
  res.send(html);
});

app.post('/save', (req, res) => {
  console.log('💾 Save configuration requested');

  const { STREAM_URL, AUDIO_DEVICE, VOLUME_NORMAL, VOLUME_CALL, CALL_AUDIO_VOLUME, PHONE, PASSWORD, show_log } = req.body;

  try {
    const radioLines = fs.readFileSync(RADIO_SH, 'utf-8').split('\n');
    const updatedRadio = radioLines.map(line => {
      if (/^STREAM_URL=/.test(line) && STREAM_URL) return `STREAM_URL="${STREAM_URL}"`;
      if (/^AUDIO_DEVICE=/.test(line) && AUDIO_DEVICE) return `AUDIO_DEVICE="${AUDIO_DEVICE}"`;
      if (/^VOLUME_NORMAL=/.test(line) && VOLUME_NORMAL) return `VOLUME_NORMAL=${VOLUME_NORMAL}`;
      if (/^VOLUME_CALL=/.test(line) && VOLUME_CALL) return `VOLUME_CALL=${VOLUME_CALL}`;
      if (/^CALL_AUDIO_VOLUME=/.test(line) && CALL_AUDIO_VOLUME) return `CALL_AUDIO_VOLUME=${CALL_AUDIO_VOLUME}`;
      return line;
    });

    fs.writeFileSync(RADIO_SH, updatedRadio.join('\n'));
    console.log('✅ Radio configuration updated');

    if (PHONE || PASSWORD) {
      const linphoneContent = fs.readFileSync(LINPHONERC, 'utf-8');
      const currentHa1Match = linphoneContent.match(/ha1=([a-f0-9]{32})/);
      const currentHa1 = currentHa1Match ? currentHa1Match[1] : '';
      const phone = PHONE || '';

      let ha1;
      if (PASSWORD && PASSWORD !== currentHa1) {
        ha1 = crypto.createHash('md5').update(`${phone}:drakes.com.au:${PASSWORD}`).digest('hex');
        console.log('✅ SIP password updated');
      } else {
        ha1 = currentHa1;
      }

      const content = linphoneContent
        .replace(/reg_identity=sip:.*?@drakes\.com\.au/, `reg_identity=sip:${phone}@drakes.com.au`)
        .replace(/username=.*/, `username=${phone}`)
        .replace(/ha1=.*/, `ha1=${ha1}`);

      fs.writeFileSync(LINPHONERC, content);
      console.log('✅ Linphone configuration updated');
    }

    trimLog();

    const restartDocker = (retry = false) => {
      console.log(`🔄 ${retry ? 'Retrying' : 'Starting'} Docker restart...`);

      exec('docker restart pa', (err, stdout, stderr) => {
        if (err && !retry) {
          console.log('❌ Docker restart failed, retrying...');
          setTimeout(() => restartDocker(true), 5000);
        } else if (err) {
          console.log('❌ Docker restart failed after retry');
        } else {
          console.log('✅ Docker restart completed');
        }
      });
    };

    setTimeout(restartDocker, 1000);

    if (show_log) {
      const logContent = fs.existsSync(RADIO_LOG) ?
        fs.readFileSync(RADIO_LOG, 'utf-8').split('\n').reverse().join('\n') :
        'No log file found.';
      res.send(`<pre>${logContent}</pre>`);
    } else {
      res.send('Configuration updated successfully. Restarting services...');
    }

  } catch (error) {
    console.error('❌ Error saving configuration:', error);
    res.status(500).send('Error saving configuration: ' + error.message);
  }
});

app.post('/restart-pulse', (req, res) => {
  setTimeout(() => {
    exec('sudo systemctl restart pulseaudio.service', (err, stdout, stderr) => {
      if (err) return res.status(500).send('Error restarting PulseAudio');
      console.log(JSON.stringify({ event: 'restart-pulse-ok', ts: new Date().toISOString() }));
      res.send('PulseAudio restarted successfully');
    });
  }, 1000);
});

app.get('/audio-devices', (req, res) => {
  exec('pactl list short sinks', (err, stdout) => {
    if (err) return res.status(500).json([]);
    const devices = stdout.trim().split('\n').map(l => l.split('\t')[1]).filter(Boolean);
    res.json(devices);
  });
});

app.get('/log-viewer', (req, res) => {
  trimLog();
  const logContent = fs.existsSync(RADIO_LOG) ? fs.readFileSync(RADIO_LOG, 'utf-8').split('\n').reverse().join('\n') : 'No log file found.';
  res.send(`<pre>${logContent}</pre>`);
});

// ------------------------
// Single Server Status Check Endpoint
// ------------------------
app.get('/check-single-server', async (req, res) => {
  const { ip } = req.query;

  if (!ip) {
    return res.json({ success: false, error: 'IP address required' });
  }

  console.log(`🔍 Checking real-time status of single server: ${ip}`);

  try {
    // Use check.sh in single server mode to get current real status
    const checkCommand = `bash /home/serveradmin/pa/check.sh single ${ip}`;

    exec(checkCommand, (error, stdout, stderr) => {
      console.log(`🔧 Command executed for ${ip}`);
      console.log(`stdout:`, stdout);
      console.log(`stderr:`, stderr);
      console.log(`error:`, error);

      // Check for IO ERROR special exit code (2) - Firewall exception
      if (error && error.code === 2) {
        console.log(`🚫 IO Error detected for ${ip} - skipping healing`);
        return res.json({
          success: true,
          status: 'fail_io_error',
          skipHealing: true,
          rawOutput: stdout.substring(0, 1000)
        });
      }

      // Even if there's an error, check if we got useful output
      if (stdout && stdout.length > 0) {

        // We got output - parse it regardless of error code
        let currentStatus = 'fail'; // Default to fail
        let skipHealing = false;   // Flag to skip healing

        console.log(`📋 Raw check output for ${ip}:`, stdout);

        // Check for IO ERROR exception - if found, skip healing
        if (hasIOErrorInLogs(stdout)) {
          console.log(`🚫 IO Error detected for ${ip} - skipping healing`);
          currentStatus = 'fail_io_error';
          skipHealing = true;
        }
        // Check for SUCCESS indicators
        else if (stdout.includes('✅ OK') ||
                stdout.includes('VERIFICATION: SUCCESS') ||
                stdout.includes('Server is healthy')) {
          currentStatus = 'ok';
        }
        // Check for ERROR indicators (unreachable, auth failed, etc.)
        else if (stdout.includes('Server not reachable') ||
                 stdout.includes('SSH connection timeout') ||
                 stdout.includes('Authentication failed') ||
                 stdout.includes('not reachable') ||
                 stdout.includes('connection refused')) {
          currentStatus = 'error';
        }

        console.log(`📊 Single server ${ip} parsed status: ${currentStatus}, skipHealing: ${skipHealing}`);

        return res.json({
          success: true,
          status: currentStatus,
          skipHealing: skipHealing,
          rawOutput: stdout.substring(0, 1000)
        });
      }

      // If we get here, we have no useful output
      if (error) {
        console.error(`❌ Single server check failed for ${ip}:`, error.message);
        return res.json({
          success: false,
          error: `Check failed: ${error.message}`,
          status: 'error'
        });
      }

      // No error but no output either
      res.json({
        success: false,
        error: 'No output received from check command',
        status: 'error'
      });
    });

  } catch (error) {
    console.error(`❌ Single server check error for ${ip}:`, error);
    res.json({
      success: false,
      error: error.message,
      status: 'error'
    });
  }
});

// ------------------------
// Serve original server order from servers.json
// ------------------------
app.get('/servers-order', (req, res) => {
  try {
    const serversFile = path.join(__dirname, 'servers.json');
    if (fs.existsSync(serversFile)) {
      const serversData = fs.readFileSync(serversFile, 'utf-8');
      const servers = JSON.parse(serversData);
      // Return only the active servers in their original order
      const activeServers = servers.active || [];
      res.json(activeServers);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error('Error reading servers order:', error);
    res.json([]);
  }
});


// ------------------------
// Start server
// ------------------------
app.listen(DASHBOARD_PORT, () => {
  console.log(`✅ Monitoring dashboard running at http://localhost:${DASHBOARD_PORT}`);
  console.log(`✅ Heal logs directory: ${healLogsDir}`);
  console.log(`✅ DUAL Auto-healing system: ENABLED`);
  console.log(`✅ Email alert system: ENABLED`);
  console.log(`✅ SMTP: ${SMTP_CONFIG.host}:${SMTP_CONFIG.port}`);
  console.log(`✅ Auto-refresh interval: 60 minutes`);

  startAutoRefreshWithHealing(30);

  setTimeout(() => {
    console.log('🚀 Running initial status check with DUAL healing...');
    
    const options = {
      hostname: 'localhost',
      port: DASHBOARD_PORT,
      path: '/refresh-now',
      method: 'POST',
      timeout: 30000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonData = JSON.parse(data);
          console.log('✅ Initial check:', jsonData.message);
        } catch (e) {
          console.log('✅ Initial check completed (non-JSON response)');
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('❌ Initial check failed:', err.message);
    });
    
    req.on('timeout', () => {
      console.error('❌ Initial check timed out');
      req.destroy();
    });
    
    req.end();
  }, 15000);
});
