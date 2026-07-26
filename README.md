# Signal Scanner — Backend (Netlify Scheduled Function)

මේ folder එකේ තියෙන්නේ site එකයි (`public/index.html`) සහ background එකේ 24/7 වැඩ කරන
serverless function එකයි (`netlify/functions/scan-signals.mts`). Phone එක/browser එක off උනත්
Netlify server එකේම හැම 5 minutes කටම RSI check කරලා, අලුත් BUY/SELL signal එකක් ආවොත් email එකක් යවනවා.

## හදගන්න ඕන දේවල් (දෙකම free)

### 1. Gmail App Password එකක්
Email යවන්නේ ඔයාගේම Gmail account එකෙන්.
1. https://myaccount.google.com/security → "2-Step Verification" on කරන්න (නැත්නම් app password ලැබෙන්නේ නෑ)
2. https://myaccount.google.com/apppasswords → app password එකක් හදගන්න (16 digit code එකක් දෙනවා)

### 2. Netlify site එකට Environment Variables දාන්න
Netlify dashboard → Site → **Site configuration → Environment variables** → මේ 3 add කරන්න:

| Key | Value |
|---|---|
| `GMAIL_USER` | ඔයාගේ Gmail address එක |
| `GMAIL_APP_PASSWORD` | ඉහත step 1 එකේදී ලැබුණු 16-digit code එක |
| `NOTIFY_TO_EMAIL` | Signal email එක යවන්න ඕන address එක (ඔයාගේම email එකවත් වෙන්න පුළුවන්) |

## Deploy කරන විදිහ

1. මේ folder එකම (root එකේම `netlify.toml` එකත් එක්ක) GitHub repo එකකට push කරන්න, නැත්නම් Netlify
   CLI වලින් `netlify deploy` කරන්න.
2. Netlify eke "New site from Git" කරලා connect කරන්න.
3. Environment variables (ඉහත) add කරන්න, redeploy කරන්න.
4. Deploy වුනාට පස්සේ, Netlify dashboard → **Functions** tab එකේ `scan-signals` කියලා
   "Scheduled" badge එකක් එක්ක පේනවා. "Run now" එකෙන් manual test කරන්නත් පුළුවන්.

## වැඩ කරන විදිහ

- හැම 5 minutes කටම (`*/5 * * * *`) Netlify server එකෙන්ම Binance eken top 50 coins scan කරනවා.
- අලුත් BUY/SELL signal එකක් හම්බුනොත් විතරයි email එක යනවා (`Netlify Blobs` use කරලා
  දැනටමත් notify කරපු signals track කරනවා — spam වෙන්නේ නෑ).
- Signal එක clear වෙලා ආයෙත් trigger උනොත්, අලුත් email එකක් යනවා.
- Phone එක/laptop එක off උනත් මේක වැඩ කරනවා — site එක browser එකේ open තියෙන්න ඕන නෑ.

## Free limits

- Netlify Scheduled Functions — free tier එකේම include වෙනවා
- Netlify Blobs — free tier එකේම include වෙනවා
- Gmail SMTP — Google account එකකට daily email limit එක (~500) — මේ use case එකට ඕන තරම් ඉතුරු
