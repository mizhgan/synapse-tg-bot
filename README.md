# Telegram Matrix Admin Bot

A secure Telegram bot for managing Matrix Synapse server users with an intuitive multilingual interface and advanced security features.

## Features

### Core Functionality
- 👥 **Get All Users**: View all users registered on your Matrix Synapse server
- 🔍 **Advanced User Search**: Search users by name, display name, or exact user ID
- ❌ **Safe User Deactivation**: Deactivate user accounts with confirmation prompts
- 👤 **Detailed User Information**: View comprehensive user details including creation time, last seen, admin status
- 📱 **Intuitive Interface**: Easy-to-use inline keyboard buttons with emoji indicators
- 📄 **Paginated Navigation**: Navigate through large user lists efficiently

### Security Features
- 🔐 **User Authorization**: Restrict access to specific Telegram user IDs or usernames
- 👑 **Admin Protection**: Administrators are automatically protected from deactivation
- 📝 **Access Logging**: All access attempts and actions are logged with timestamps
- 🚫 **Unauthorized Access Blocking**: Immediate blocking and logging of unauthorized attempts
- ⚠️ **Confirmation Dialogs**: Multiple confirmation steps for destructive actions

### Multi-language Support
- 🇺🇸 **English Version**: `bot-complete.js` - Full-featured English interface
- 🇷🇺 **Russian Version**: `bot-ru.js` - Complete Russian localization
- 🔄 **Easy Switching**: Switch between language versions via package.json scripts

## Prerequisites

- Node.js (v14 or higher)
- A Matrix Synapse server with admin access
- A Telegram bot token from [@BotFather](https://t.me/botfather)
- Matrix admin access token

## Installation

1. **Clone or download the project files**
   ```bash
   # Files should include:
   # - package.json
   # - bot.js
   # - .env.example
   # - README.md
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   nano .env  # or use your preferred editor
   ```

## Configuration

### 1. Get Telegram Bot Token

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Create a new bot with `/newbot`
3. Follow the prompts to get your bot token
4. Copy the token to your `.env` file

### 2. Get Matrix Admin Token

You need an admin access token for your Matrix Synapse server. You can get this by:

**Option A: Using an existing admin user**
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"type":"m.login.password","user":"admin","password":"your_admin_password"}' \
  "https://your-matrix-server.com/_matrix/client/r0/login"
```

**Option B: Generate admin token via Synapse**
```bash
# On your Synapse server
python -m synapse.app.admin_cmd -c /path/to/homeserver.yaml \
  generate-admin-token @admin:your-domain.com
```

### 3. Configure .env file

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyZ123456789

# Matrix Synapse Server Configuration  
MATRIX_URL=https://your-matrix-server.com
MATRIX_ADMIN_TOKEN=syt_YWRtaW4_abcdefghijklmnopqrstuvwxyz_123456
```

## Usage

### Starting the Bot

```bash
# Production
npm start

# Development (with auto-restart)
npm run dev
```

### Bot Commands

- `/start` - Show main menu and welcome message
- `/help` - Display help information
- `/menu` - Return to main menu at any time

### Bot Features

#### Get All Users
- Click "👥 Get All Users" to see all registered users
- Shows user ID, display name, status (active/deactivated), and user type
- Lists are automatically truncated if too long for Telegram

#### Deactivate User
- Click "❌ Deactivate User" to see paginated list of active users
- Navigate through pages with Previous/Next buttons
- Select a user to see confirmation prompt
- Confirm deactivation (this action cannot be undone)

## Security Considerations

⚠️ **Important Security Notes:**

1. **Admin Token**: Keep your Matrix admin token secure - it has full server access
2. **Bot Access**: Only give bot access to trusted administrators
3. **Environment File**: Never commit `.env` file to version control
4. **Network**: Consider running on a secure network or VPN
5. **Logging**: Monitor bot logs for suspicious activity

## API Endpoints Used

The bot uses these Matrix Synapse Admin API endpoints:

- `GET /_synapse/admin/v2/users` - List users
- `POST /_synapse/admin/v1/deactivate/{user_id}` - Deactivate user

## Error Handling

The bot includes comprehensive error handling for:

- Network connectivity issues
- Invalid Matrix server responses
- Authentication failures
- User not found errors
- Telegram API errors

## Troubleshooting

### Common Issues

**Bot doesn't respond**
- Check if bot token is correct
- Verify bot is started and polling
- Check network connectivity

**Matrix API errors**
- Verify Matrix server URL format (include https://)
- Check admin token validity
- Ensure admin user has required permissions
- Verify Matrix server is accessible

**"Failed to fetch users" error**
- Check Matrix server URL and admin token
- Verify admin API is enabled on your Synapse server
- Check server logs for detailed error information

### Debugging

Enable debug logging by adding to your bot.js:

```javascript
// Add after require statements
process.env.NTBA_FIX_319 = 1;
process.env.NTBA_FIX_350 = 1;
```

## Development

### Project Structure

```
├── package.json          # Dependencies and scripts
├── bot.js                # Main bot application
├── .env.example          # Environment template
├── .env                  # Your configuration (not in git)
└── README.md             # This file
```

### Adding Features

The bot is structured with:

- `MatrixClient` class for API operations
- Keyboard generation functions
- Command handlers for `/start`, `/help`, etc.
- Callback query handler for button interactions
- Error handling and user state management

## License

MIT License - feel free to modify and distribute.

## Support

For issues related to:
- **Bot functionality**: Check the troubleshooting section
- **Matrix Synapse**: Consult [Synapse documentation](https://matrix-org.github.io/synapse/)
- **Telegram Bot API**: See [official documentation](https://core.telegram.org/bots/api)