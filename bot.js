require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Bot configuration
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Matrix Synapse configuration
const MATRIX_URL = process.env.MATRIX_URL;
const MATRIX_ADMIN_TOKEN = process.env.MATRIX_ADMIN_TOKEN;

// Security configuration
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS ? 
    process.env.AUTHORIZED_USERS.split(',').map(id => parseInt(id.trim())) : [];
const AUTHORIZED_USERNAMES = process.env.AUTHORIZED_USERNAMES ? 
    process.env.AUTHORIZED_USERNAMES.split(',').map(username => username.trim().toLowerCase()) : [];

// Authorization functions
function isAuthorized(user) {
    // If no authorized users configured, allow all (backward compatibility)
    if (AUTHORIZED_USERS.length === 0 && AUTHORIZED_USERNAMES.length === 0) {
        console.warn('⚠️  No authorized users configured! Anyone can use this bot.');
        return true;
    }
    
    // Check user ID
    if (AUTHORIZED_USERS.includes(user.id)) {
        return true;
    }
    
    // Check username (case insensitive)
    if (user.username && AUTHORIZED_USERNAMES.includes(user.username.toLowerCase())) {
        return true;
    }
    
    return false;
}

function logUnauthorizedAccess(user, command) {
    const userInfo = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    const username = user.username ? `@${user.username}` : 'no username';
    console.warn(`🚫 Unauthorized access attempt:`);
    console.warn(`   User: ${userInfo} (${username})`);
    console.warn(`   ID: ${user.id}`);
    console.warn(`   Command: ${command}`);
    console.warn(`   Time: ${new Date().toISOString()}`);
}

function sendUnauthorizedMessage(chatId) {
    const message = `🚫 *Access Denied*\n\nYou are not authorized to use this bot.\n\nThis bot is restricted to specific users only.\nIf you believe this is an error, contact the administrator.`;
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Store user states for multi-step operations
const userStates = new Map();

// Matrix API client
class MatrixClient {
    constructor(baseUrl, adminToken) {
        this.baseUrl = baseUrl;
        this.adminToken = adminToken;
        this.headers = {
            'Authorization': `Bearer ${adminToken}`,
            'Content-Type': 'application/json'
        };
    }

    async getUsers(from = 0, limit = 100) {
        try {
            const response = await axios.get(
                `${this.baseUrl}/_synapse/admin/v2/users`,
                {
                    headers: this.headers,
                    params: { from, limit }
                }
            );
            return response.data;
        } catch (error) {
            console.error('Error fetching users:', error.response?.data || error.message);
            throw new Error(`Failed to fetch users: ${error.response?.data?.error || error.message}`);
        }
    }

    async deactivateUser(userId) {
        try {
            const response = await axios.post(
                `${this.baseUrl}/_synapse/admin/v1/deactivate/${encodeURIComponent(userId)}`,
                { erase: false },
                { headers: this.headers }
            );
            return response.data;
        } catch (error) {
            console.error('Error deactivating user:', error.response?.data || error.message);
            throw new Error(`Failed to deactivate user: ${error.response?.data?.error || error.message}`);
        }
    }
}

const matrixClient = new MatrixClient(MATRIX_URL, MATRIX_ADMIN_TOKEN);

// Utility functions
function createMainKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '👥 Get All Users', callback_data: 'get_users' }],
                [{ text: '❌ Deactivate User', callback_data: 'deactivate_menu' }]
            ]
        }
    };
}

function createUserSelectionKeyboard(users, page = 0, usersPerPage = 10) {
    const startIndex = page * usersPerPage;
    const endIndex = Math.min(startIndex + usersPerPage, users.length);
    const pageUsers = users.slice(startIndex, endIndex);
    
    const keyboard = [];
    
    // Add user buttons
    pageUsers.forEach(user => {
        keyboard.push([{
            text: `${user.displayname || user.name} (${user.user_type || 'regular'})`,
            callback_data: `deactivate_${user.name}`
        }]);
    });
    
    // Add navigation buttons
    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀️ Previous', callback_data: `users_page_${page - 1}` });
    }
    if (endIndex < users.length) {
        navRow.push({ text: 'Next ▶️', callback_data: `users_page_${page + 1}` });
    }
    if (navRow.length > 0) {
        keyboard.push(navRow);
    }
    
    // Add back button
    keyboard.push([{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]);
    
    return { reply_markup: { inline_keyboard: keyboard } };
}

// Command handlers
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `
🤖 *Matrix Synapse Admin Bot*

This bot helps you manage your Matrix Synapse server.

Available actions:
• Get all users from the server
• Deactivate selected users

Choose an action from the menu below:
    `;
    
    bot.sendMessage(chatId, welcomeMessage, {
        parse_mode: 'Markdown',
        ...createMainKeyboard()
    });
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
📖 *Help - Matrix Synapse Admin Bot*

*Commands:*
• /start - Show main menu
• /help - Show this help message
• /menu - Return to main menu

*Features:*
• View all users on your Matrix server
• Deactivate user accounts
• Paginated user lists for easy navigation

*Requirements:*
• Bot must be configured with Matrix admin token
• You must have admin privileges on the Matrix server

*Security Note:*
This bot has admin privileges. Only authorized users should have access.
    `;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/menu/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Choose an action:', createMainKeyboard());
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
        if (data === 'get_users') {
            await bot.editMessageText('🔄 Fetching users from Matrix server...', {
                chat_id: chatId,
                message_id: messageId
            });

            const usersData = await matrixClient.getUsers();
            const users = usersData.users || [];
            
            if (users.length === 0) {
                await bot.editMessageText('ℹ️ No users found on the server.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                    }
                });
                return;
            }

            let usersList = `👥 *Users on Matrix Server* (${users.length} total)\n\n`;
            users.forEach((user, index) => {
                const status = user.deactivated ? '❌ Deactivated' : '✅ Active';
                const userType = user.admin ? ' (Admin)' : user.user_type ? ` (${user.user_type})` : '';
                usersList += `${index + 1}. ${user.displayname || user.name}${userType}\n`;
                usersList += `   └ ${user.name} - ${status}\n\n`;
            });

            // Split message if too long
            if (usersList.length > 4096) {
                usersList = usersList.substring(0, 4090) + '...\n\n_List truncated_';
            }

            await bot.editMessageText(usersList, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                }
            });

        } else if (data === 'deactivate_menu') {
            await bot.editMessageText('🔄 Loading users for deactivation...', {
                chat_id: chatId,
                message_id: messageId
            });

            const usersData = await matrixClient.getUsers();
            const activeUsers = (usersData.users || []).filter(user => !user.deactivated);
            
            if (activeUsers.length === 0) {
                await bot.editMessageText('ℹ️ No active users found to deactivate.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
                    }
                });
                return;
            }

            userStates.set(chatId, { users: activeUsers, page: 0 });

            await bot.editMessageText('❌ *Select user to deactivate:*', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                ...createUserSelectionKeyboard(activeUsers, 0)
            });

        } else if (data.startsWith('users_page_')) {
            const page = parseInt(data.split('_')[2]);
            const state = userStates.get(chatId);
            
            if (state && state.users) {
                state.page = page;
                userStates.set(chatId, state);
                
                await bot.editMessageReplyMarkup(
                    createUserSelectionKeyboard(state.users, page).reply_markup,
                    { chat_id: chatId, message_id: messageId }
                );
            }

        } else if (data.startsWith('deactivate_')) {
            const userId = data.substring('deactivate_'.length);
            
            await bot.editMessageText(`⚠️ *Confirm Deactivation*\n\nAre you sure you want to deactivate user:\n\`${userId}\`\n\n⚠️ This action cannot be undone!`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Yes, Deactivate', callback_data: `confirm_deactivate_${userId}` },
                            { text: '❌ Cancel', callback_data: 'deactivate_menu' }
                        ]
                    ]
                }
            });

        } else if (data.startsWith('confirm_deactivate_')) {
            const userId = data.substring('confirm_deactivate_'.length);
            
            await bot.editMessageText(`🔄 Deactivating user ${userId}...`, {
                chat_id: chatId,
                message_id: messageId
            });

            try {
                await matrixClient.deactivateUser(userId);
                
                await bot.editMessageText(`✅ *User Deactivated Successfully*\n\nUser \`${userId}\` has been deactivated.`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '❌ Deactivate Another', callback_data: 'deactivate_menu' }],
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            } catch (error) {
                await bot.editMessageText(`❌ *Deactivation Failed*\n\nError: ${error.message}`, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 Try Again', callback_data: 'deactivate_menu' }],
                            [{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
            }

        } else if (data === 'back_to_menu') {
            userStates.delete(chatId);
            await bot.editMessageText('Choose an action:', {
                chat_id: chatId,
                message_id: messageId,
                ...createMainKeyboard()
            });
        }

    } catch (error) {
        console.error('Callback query error:', error);
        await bot.editMessageText(`❌ Error: ${error.message}`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_menu' }]]
            }
        });
    }

    // Answer callback query to remove loading state
    bot.answerCallbackQuery(callbackQuery.id);
});

// Error handling
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

process.on('SIGINT', () => {
    console.log('Bot stopping...');
    bot.stopPolling();
    process.exit(0);
});

console.log('🤖 Telegram Matrix Admin Bot started...');