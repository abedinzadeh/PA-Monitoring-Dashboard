cat >/etc/systemd/system/pa-monitoring.service << 'EOF'
[Unit]
Description=PA Monitoring Dashboard
After=network.target

[Service]
Type=simple
User=serveradmin
Group=serveradmin
WorkingDirectory=/home/serveradmin/pa/monitoring-dashboard
ExecStart=/usr/bin/node /home/serveradmin/pa/monitoring-dashboard/dashboard.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=3003
[Install]
WantedBy=multi-user.target

EOF

sudo systemctl daemon-reload
sudo systemctl enable pa-monitoring.service
sudo systemctl start pa-monitoring.service

# Check status
sudo systemctl status pa-monitoring.service
