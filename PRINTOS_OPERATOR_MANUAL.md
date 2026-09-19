# PRINTOS — Shop Operator & Counter Staff Manual

A simple, practical guide for print shop owners, counter staff, and operators running PRINTOS on a daily basis.

---

## 📖 Welcome to PRINTOS!

**PRINTOS** is an automated self-service printing system for your shop. 

### How it helps your shop:
- **No more WhatsApp Web or pendrive hassles**: Customers send their files directly to your shop's WhatsApp number.
- **Automated Pricing & Payments**: The system calculates the exact price and provides an instant UPI QR code.
- **Instant Silent Printing**: As soon as the customer pays on UPI (GPay, PhonePe, Paytm), the document automatically prints on your counter printer!

---

## ☀️ 1. Daily Morning Routine (Opening the Shop)

Follow these 4 simple steps every morning when opening your shop:

1. **Turn on the Hardware**:
   - Power ON your counter computer (Windows PC).
   - Power ON all connected printers (USB or LAN Wi-Fi).
2. **Check Paper & Supplies**:
   - Refill paper trays with clean **A4**, **A3**, or **Legal** paper.
   - Check toner / ink levels on your printer screen.
3. **Verify the Windows Print Agent**:
   - The Print Agent runs automatically in the background on your PC.
   - If starting manually, open PowerShell and run:
     ```powershell
     npm run agent:windows
     ```
4. **Open the Admin Dashboard**:
   - Open your web browser (Chrome, Edge, Firefox).
   - Go to your shop's admin URL (e.g., `https://printos.yourdomain.com/admin` or `http://localhost:3000/admin`).
   - Log in with your staff email and password.
   - Look at the top-right status: ensure your printer shows **ONLINE** with a green dot.

---

## 📱 2. How Customers Place Orders (Customer Journey)

Here is what your customers experience when printing at your shop:

```
[ Step 1: Send File ] ──▶ [ Step 2: Choose Settings ] ──▶ [ Step 3: Scan UPI QR ] ──▶ [ Step 4: Collect Printout! ]
  Customer sends PDF         B&W / Color, Copies,            Customer pays via            Printer automatically
  or image on WhatsApp       Duplex, Page numbers            GPay / PhonePe / Paytm       prints the document
```

1. **Step 1: Customer sends file on WhatsApp**
   - The customer sends a PDF, JPG, or PNG document to your shop's WhatsApp number.
2. **Step 2: Bot asks for print preferences**
   - The automated assistant asks:
     - **Color Mode**: Black & White (B&W) or Full Color?
     - **Sides**: Single-sided or Double-sided (Duplex)?
     - **Copies**: How many copies (e.g. 1, 2, 5)?
     - **Pages**: All pages or specific pages (e.g. `1-5, 8, 10`)?
3. **Step 3: Instant UPI QR Code & Payment**
   - The bot calculates the exact total in Rupees and sends a dynamic UPI QR code.
   - The customer scans and pays using any UPI app (Google Pay, PhonePe, Paytm, BHIM).
4. **Step 4: Automatic Printing**
   - The moment payment succeeds, your printer starts printing.
   - Staff simply picks up the printout and hands it to the customer!

---

## 🖥️ 3. Using the Admin Dashboard

The Admin Dashboard gives you full visibility into your shop's operations in real time.

### A. Main Dashboard Overview (`/admin`)
- **Today's Orders**: Total number of orders received today.
- **Active Queue**: Number of jobs currently waiting to print.
- **Printing Now**: Jobs actively spooling to physical printers.
- **Completed**: Total successfully printed orders.
- **Total Revenue**: Total money collected today (in ₹ Rupees).
- **Pages Printed**: Total sheets printed today.

### B. Live Print Queue (`/admin/queue`)
- Displays all jobs in first-in, first-out (FIFO) order.
- Shows customer phone number, file name, page count, color mode, and copies.
- Updates automatically every 2 seconds without needing to refresh the page.

### C. Orders History (`/admin/orders`)
- A complete history of all customer orders.
- **Order Statuses**:
  - `DRAFT`: Customer is chatting with bot and configuring settings.
  - `AWAITING_PAYMENT`: Bot sent the payment QR; waiting for customer to pay.
  - `PAID`: Payment received; preparing print job.
  - `QUEUED`: Job is waiting in queue for the printer.
  - `PRINTING`: Printer is actively printing the pages.
  - `COMPLETED`: Successfully printed.
  - `FAILED`: Printing failed (e.g., paper jam or printer offline).
  - `CANCELLED`: Order was cancelled before payment.

### D. Printers & Hardware Status (`/admin/printers`)
- Displays all connected printers and their health.
- **Status Indicators**:
  - 🟢 **ONLINE**: Printer is connected, healthy, and ready to print.
  - 🔴 **OFFLINE**: Printer is turned off, disconnected, or having a driver issue.
- Displays supported capabilities: Color support, Double-sided (Duplex) printing, and Paper sizes.

### E. Shop Management & Branch Settings (`/admin/shops`)
- View and manage your print shop branch profile, phone numbers, and physical counter address.
- Monitor per-shop operational statistics: orders count, active queue, online printers, and total revenue.
- Multi-shop owners can configure new branch locations and toggle shop online/offline availability.

---

## 💰 4. Print Pricing & Settings

PRINTOS calculates prices automatically with zero rounding errors using integer paisa:

| Option | Standard Price (Example) | Description |
| :--- | :--- | :--- |
| **Black & White (B&W) Single-Sided** | ₹2.00 / page | Standard black & white document printing |
| **Black & White (B&W) Double-Sided** | ₹3.50 / sheet | Discounted double-sided printing |
| **Full Color Single-Sided** | ₹10.00 / page | Color graphics, photos, certificates |
| **Full Color Double-Sided** | ₹18.00 / sheet | Color double-sided printing |

*Note: If your shop adjusts base rates, your system administrator can update the shop's pricing table in the settings.*

---

## ⚠️ 5. Handling Common Problems (Troubleshooting)

### Problem 1: Paper Jam During Printing
1. Open the printer cover and gently remove the jammed paper.
2. Close the printer cover and ensure paper is aligned in the tray.
3. The Print Agent will detect the error, report `FAILED`, and automatically attempt to re-print the job up to 3 times once the printer is clear.

### Problem 2: Printer Runs Out of Paper Mid-Job
1. Add fresh paper to the printer tray.
2. The printer will automatically continue printing the remaining pages.

### Problem 3: Printer Shows "OFFLINE" on Dashboard
1. Check if the printer power switch is turned ON.
2. Check if the USB cable is firmly plugged into both the printer and the shop PC (or Wi-Fi is connected).
3. Check the printer's screen for any hardware error messages.
4. Within 10 seconds of fixing the physical connection, the status on `/admin/printers` will automatically turn green (**ONLINE**).

### Problem 4: Customer Paid but Printing Did Not Start
1. Open the Admin Dashboard ➔ Go to **Orders** (`/admin/orders`).
2. Search for the customer's phone number or Order ID.
3. Check the status:
   - If status is `PAID` / `QUEUED`: The printer may be finishing a previous job or the agent is waking up. It will start shortly.
   - If status is `FAILED`: Check if the printer has a paper jam or is turned off.
   - If status is `AWAITING_PAYMENT`: The payment is still processing at the customer's bank. Ask the customer to show the UPI transaction success screen.

### Problem 5: Customer Wants to Cancel Before Payment
- If the customer hasn't paid yet, they can simply type `cancel` in WhatsApp. The order will cancel automatically.
- No charge will occur.

---

## 🔒 6. Logging In and Out of the Admin Portal

### How to Log In:
1. Navigate to `/admin` in your browser.
2. You will be redirected to the login page (`/admin/login`).
3. Enter your staff email address and password.
4. Click **Sign In**.

### How to Log Out:
1. Click the **Staff Profile / Sign Out** button in the top-right corner of the dashboard.
2. Always log out at the end of your shift if using a shared counter computer.

---

## 🌙 7. Evening Routine (Closing the Shop)

Before closing your shop each night:

1. **Check Daily Summary**:
   - Go to `/admin`.
   - Note down today's total revenue (₹) and total pages printed for your records.
2. **Verify Queue is Clear**:
   - Check `/admin/queue` to make sure all customer jobs are completed.
3. **Log Out**:
   - Click **Sign Out** in the admin header.
4. **Power Down Safely**:
   - Turn off printers using their power buttons (avoids printhead clogging).
   - Shut down or lock the counter computer.

---

## 🚨 When to Contact Technical Support

Contact your system administrator or technical support team if:

1. The Admin Dashboard shows **"Database Error"** or fails to load.
2. The Print Agent consistently reports **"401 Invalid Agent Token"** after PC reboot.
3. Customer payments succeed on UPI but orders stay in `AWAITING_PAYMENT` (webhook issue).
4. WhatsApp bot stops responding to all incoming customer messages.

---

*PRINTOS — Fast, Automated Self-Service Printing for Modern Print Shops.*
