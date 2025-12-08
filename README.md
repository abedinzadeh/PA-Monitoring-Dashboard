Here is a clean, structured, and GitHub-friendly README version:

---

# PA Monitoring Dashboard

The **PA Monitoring Dashboard** provides real-time visibility into the health of all PA servers and includes built-in **self-healing automation**, interactive tools, and log insights. This system is designed to simplify management of multi-server PA environments and reduce the need for manual intervention.

---

## 📁 Project Structure & Requirements

This project assumes:

* A Linux user named **`serveradmin`** exists on all servers.

* All dashboard files are stored under:

  ```
  /home/serveradmin/pa/
  ```

* Your PA system is already set up according to the instructions from the related PA project on GitHub.

* The list of PA servers is defined in:

  ```
  pa/monitoring-dashboard/server.json
  ```

* Each server’s **serveradmin password** is configured in the file:

  ```
  pa/check.sh
  ```

---

## ⚙️ How the Monitoring Process Works

The dashboard backend (`dashboard.js`) runs the monitoring script every **30 minutes**.
For each server, the script performs the following steps:

1. Connects via **SSH** using the `serveradmin` account.
2. Reads the **last 40 lines** of the PA log file.
3. Searches for the keyword **"successful"**:

   * If found → the PA service is marked **OK**.
   * If not found → recovery actions begin.

### 🛠️ Self-Healing Logic

If no “successful” entry is detected and the server is reachable:

1. Restart PulseAudio:

   ```
   systemctl restart pulseaudio
   ```
2. Wait 1 minute.
3. Restart the PA Docker container through the server’s vPA API:

   ```
   docker restart pa
   ```
4. Re-check logs and update the server status accordingly.

---

## 🖥️ Dashboard Service (Systemd)

To install and enable the dashboard as a systemd service, run:

```
pa/pa-monitoring systemd creation.sh
```

The dashboard will run on **port 3003**.

---

## ✨ Features

* **Self-Healing Automation** – detects and repairs common failures
* **Smart Email Alerts** – prioritised & meaningful notifications
* **Interactive Server Controls** – manage servers without logging into each one
* **Manual Healing Tools** – full control when you want to intervene
* **One-Click Log Access** – simplify debugging and collaboration
* **Dark Mode** – because real engineers troubleshoot at night 😄
* **Mobile-Friendly UI** – works smoothly on any device
* **High-Performance Frontend** – responsive even under heavy load

---

## ✔️ Summary

The PA Monitoring Dashboard is a robust solution for automating PA service checks, recovering service failures, and centralizing control across multiple sites. By combining automation, a clean UI, and remote actions, it significantly reduces manual troubleshooting time.



Thanks
Hossein
