require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

// Конфигурация бота
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Конфигурация Matrix Synapse
const MATRIX_URL = process.env.MATRIX_URL;
const MATRIX_ADMIN_TOKEN = process.env.MATRIX_ADMIN_TOKEN;

// Конфигурация безопасности
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS
  ? process.env.AUTHORIZED_USERS.split(",").map((id) => parseInt(id.trim()))
  : [];
const AUTHORIZED_USERNAMES = process.env.AUTHORIZED_USERNAMES
  ? process.env.AUTHORIZED_USERNAMES.split(",").map((username) =>
      username.trim().toLowerCase()
    )
  : [];

// Хранение состояний пользователей для многошаговых операций
const userStates = new Map();

// Функции авторизации
function isAuthorized(user) {
  // Если нет настроенных авторизованных пользователей, запретить весь доступ для безопасности
  if (AUTHORIZED_USERS.length === 0 && AUTHORIZED_USERNAMES.length === 0) {
    console.error(
      "⚠️  Не настроены авторизованные пользователи! Бот заблокирован."
    );
    return false;
  }

  // Проверка ID пользователя
  if (AUTHORIZED_USERS.includes(user.id)) {
    return true;
  }

  // Проверка имени пользователя (нечувствительно к регистру)
  if (
    user.username &&
    AUTHORIZED_USERNAMES.includes(user.username.toLowerCase())
  ) {
    return true;
  }

  return false;
}

function logUnauthorizedAccess(user, command) {
  const userInfo = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username
    ? `@${user.username}`
    : "нет имени пользователя";
  console.warn(`🚫 Попытка неавторизованного доступа:`);
  console.warn(`   Пользователь: ${userInfo} (${username})`);
  console.warn(`   ID: ${user.id}`);
  console.warn(`   Команда: ${command}`);
  console.warn(`   Время: ${new Date().toISOString()}`);
}

function sendUnauthorizedMessage(chatId) {
  const message = `🚫 *Доступ запрещен*\n\nВы не авторизованы для использования этого бота.\n\nЭтот бот доступен только определенным пользователям.\nЕсли вы считаете, что это ошибка, обратитесь к администратору.`;
  bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

function logAuthorizedAccess(user, command) {
  const userInfo = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username
    ? `@${user.username}`
    : "нет имени пользователя";
  console.log(`✅ Авторизованный доступ:`);
  console.log(`   Пользователь: ${userInfo} (${username})`);
  console.log(`   ID: ${user.id}`);
  console.log(`   Команда: ${command}`);
  console.log(`   Время: ${new Date().toISOString()}`);
}

// Middleware авторизации
function requireAuth(handler) {
  return (msg, match) => {
    const user = msg.from;
    const command = msg.text || "callback";

    if (!isAuthorized(user)) {
      logUnauthorizedAccess(user, command);
      sendUnauthorizedMessage(msg.chat.id);
      return;
    }

    logAuthorizedAccess(user, command);
    handler(msg, match);
  };
}

function requireAuthCallback(handler) {
  return (callbackQuery) => {
    const user = callbackQuery.from;
    const command = `callback: ${callbackQuery.data}`;

    if (!isAuthorized(user)) {
      logUnauthorizedAccess(user, command);
      sendUnauthorizedMessage(callbackQuery.message.chat.id);
      bot.answerCallbackQuery(callbackQuery.id, { text: "Доступ запрещен" });
      return;
    }

    logAuthorizedAccess(user, command);
    handler(callbackQuery);
  };
}

// Клиент Matrix API
class MatrixClient {
  constructor(baseUrl, adminToken) {
    this.baseUrl = baseUrl;
    this.adminToken = adminToken;
    this.headers = {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };
  }

  async getUsers(from = 0, limit = 100) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/_synapse/admin/v2/users`,
        {
          headers: this.headers,
          params: { from, limit },
        }
      );
      return response.data;
    } catch (error) {
      console.error(
        "Ошибка получения пользователей:",
        error.response?.data || error.message
      );
      throw new Error(
        `Не удалось получить пользователей: ${
          error.response?.data?.error || error.message
        }`
      );
    }
  }

  async deactivateUser(userId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/_synapse/admin/v1/deactivate/${encodeURIComponent(
          userId
        )}`,
        { erase: false },
        { headers: this.headers }
      );
      return response.data;
    } catch (error) {
      console.error(
        "Ошибка деактивации пользователя:",
        error.response?.data || error.message
      );
      throw new Error(
        `Не удалось деактивировать пользователя: ${
          error.response?.data?.error || error.message
        }`
      );
    }
  }

  async searchUsers(searchTerm, from = 0, limit = 100) {
    try {
      // Сначала получаем всех пользователей (Matrix не имеет встроенного поиска)
      const response = await axios.get(
        `${this.baseUrl}/_synapse/admin/v2/users`,
        {
          headers: this.headers,
          params: { from: 0, limit: 1000 }, // Получаем больше пользователей для поиска
        }
      );

      const allUsers = response.data.users || [];
      const searchLower = searchTerm.toLowerCase();

      // Фильтруем пользователей на основе поискового запроса
      const filteredUsers = allUsers.filter((user) => {
        return (
          user.name.toLowerCase().includes(searchLower) ||
          (user.displayname &&
            user.displayname.toLowerCase().includes(searchLower)) ||
          user.name === searchTerm // Точное совпадение для ID пользователей
        );
      });

      // Применяем пагинацию к отфильтрованным результатам
      const startIndex = from;
      const endIndex = Math.min(startIndex + limit, filteredUsers.length);
      const paginatedUsers = filteredUsers.slice(startIndex, endIndex);

      return {
        users: paginatedUsers,
        total: filteredUsers.length,
        from: from,
        limit: limit,
      };
    } catch (error) {
      console.error(
        "Ошибка поиска пользователей:",
        error.response?.data || error.message
      );
      throw new Error(
        `Не удалось найти пользователей: ${
          error.response?.data?.error || error.message
        }`
      );
    }
  }

  async getUserInfo(userId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}`,
        { headers: this.headers }
      );
      return response.data;
    } catch (error) {
      console.error(
        "Ошибка получения информации о пользователе:",
        error.response?.data || error.message
      );
      throw new Error(
        `Не удалось получить информацию о пользователе: ${
          error.response?.data?.error || error.message
        }`
      );
    }
  }
}

const matrixClient = new MatrixClient(MATRIX_URL, MATRIX_ADMIN_TOKEN);

// Вспомогательные функции
function createMainKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "👥 Все пользователи", callback_data: "get_users" }],
        [{ text: "🔍 Поиск пользователей", callback_data: "search_users" }],
        [
          {
            text: "❌ Деактивировать пользователя",
            callback_data: "deactivate_menu",
          },
        ],
        [{ text: "🔒 Моя информация", callback_data: "show_my_info" }],
      ],
    },
  };
}

function createUserSelectionKeyboard(
  users,
  page = 0,
  usersPerPage = 10,
  actionPrefix = "deactivate"
) {
  const startIndex = page * usersPerPage;
  const endIndex = Math.min(startIndex + usersPerPage, users.length);
  const pageUsers = users.slice(startIndex, endIndex);

  const keyboard = [];

  // Добавляем кнопки пользователей
  pageUsers.forEach((user) => {
    const status = user.deactivated ? "❌" : "✅";
    const userType = user.admin
      ? " 👑"
      : user.user_type
      ? ` (${user.user_type})`
      : "";
    keyboard.push([
      {
        text: `${status} ${user.displayname || user.name}${userType}`,
        callback_data: `${actionPrefix}_${user.name}`,
      },
    ]);
  });

  // Добавляем кнопки навигации
  const navRow = [];
  if (page > 0) {
    navRow.push({
      text: "◀️ Назад",
      callback_data: `${actionPrefix}_page_${page - 1}`,
    });
  }
  if (endIndex < users.length) {
    navRow.push({
      text: "Далее ▶️",
      callback_data: `${actionPrefix}_page_${page + 1}`,
    });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  // Добавляем кнопку возврата
  keyboard.push([{ text: "🔙 В главное меню", callback_data: "back_to_menu" }]);

  return { reply_markup: { inline_keyboard: keyboard } };
}

function createSearchResultKeyboard(
  users,
  searchTerm,
  page = 0,
  usersPerPage = 10
) {
  const startIndex = page * usersPerPage;
  const endIndex = Math.min(startIndex + usersPerPage, users.length);
  const pageUsers = users.slice(startIndex, endIndex);

  const keyboard = [];

  // Добавляем кнопки пользователей с информацией и опциями деактивации
  pageUsers.forEach((user) => {
    const status = user.deactivated ? "❌" : "✅";
    const userType = user.admin
      ? " 👑"
      : user.user_type
      ? ` (${user.user_type})`
      : "";

    let actionButton;
    if (user.deactivated) {
      actionButton = { text: "❌ Деактивирован", callback_data: "noop" };
    } else if (user.admin) {
      actionButton = { text: "👑 Админ защищен", callback_data: "noop" };
    } else {
      actionButton = {
        text: "🗑️ Деактивировать",
        callback_data: `deactivate_${user.name}`,
      };
    }
    keyboard.push([
      {
        text: `${status} ${user.displayname} ${user.name}${userType}`,
        callback_data: `userinfo_${user.name}`,
      },
      actionButton,
    ]);
  });

  // Добавляем кнопки навигации
  const navRow = [];
  if (page > 0) {
    navRow.push({ text: "◀️ Назад", callback_data: `search_page_${page - 1}` });
  }
  if (endIndex < users.length) {
    navRow.push({ text: "Далее ▶️", callback_data: `search_page_${page + 1}` });
  }
  if (navRow.length > 0) {
    keyboard.push(navRow);
  }

  // Добавляем кнопки нового поиска и возврата
  keyboard.push([
    { text: "🔍 Новый поиск", callback_data: "search_users" },
    { text: "🔙 В главное меню", callback_data: "back_to_menu" },
  ]);

  return { reply_markup: { inline_keyboard: keyboard } };
}

// Обработчики команд с авторизацией
bot.onText(
  /\/start/,
  requireAuth((msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const userInfo = `${user.first_name || ""} ${user.last_name || ""}`.trim();

    const welcomeMessage = `
🤖 *Бот администрирования Matrix Synapse*

Добро пожаловать, ${userInfo}!

Этот бот поможет вам управлять сервером Matrix Synapse.

Доступные действия:
• Просмотр всех пользователей сервера
• Поиск конкретных пользователей
• Деактивация выбранных пользователей
• Просмотр информации о вашей авторизации

Выберите действие из меню ниже:
    `;

    bot.sendMessage(chatId, welcomeMessage, {
      parse_mode: "Markdown",
      ...createMainKeyboard(),
    });
  })
);

bot.onText(
  /\/help/,
  requireAuth((msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `
📖 *Справка - Бот администрирования Matrix Synapse*

*Команды:*
• /start - Показать главное меню
• /help - Показать эту справку
• /menu - Вернуться в главное меню
• /whoami - Показать информацию о вас
• /search <запрос> - Быстрый поиск пользователей

*Функции:*
• Просмотр всех пользователей на вашем Matrix сервере
• Поиск пользователей по имени, отображаемому имени или ID пользователя
• Деактивация учетных записей пользователей
• Просмотр подробной информации о пользователях
• Навигация по спискам пользователей с пагинацией
• Безопасный контроль доступа

*Советы по поиску:*
• Поиск по части имени: "иван"
• Поиск по отображаемому имени: "Иван Иванов"
• Поиск по точному ID пользователя: "@user:example.com"
• Поиск нечувствителен к регистру

*Безопасность:*
• Только авторизованные пользователи могут получить доступ к этому боту
• Все попытки доступа регистрируются
• Авторизация пользователей проверяется для каждого действия
• Администраторы защищены от деактивации

*Требования:*
• Бот должен быть настроен с токеном администратора Matrix
• У вас должны быть права администратора на сервере Matrix
• Ваш Telegram ID или имя пользователя должны быть в списке авторизованных
    `;

    bot.sendMessage(chatId, helpMessage, { parse_mode: "Markdown" });
  })
);

bot.onText(
  /\/menu/,
  requireAuth((msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "Выберите действие:", createMainKeyboard());
  })
);

bot.onText(
  /\/whoami/,
  requireAuth((msg) => {
    const chatId = msg.chat.id;
    const user = msg.from;
    const userInfo = `${user.first_name || ""} ${user.last_name || ""}`.trim();
    const username = user.username
      ? `@${user.username}`
      : "Нет имени пользователя";

    const message = `
🔒 *Информация о вашей авторизации*

*Имя:* ${userInfo}
*Имя пользователя:* ${username}
*ID пользователя:* \`${user.id}\`
*Язык:* ${user.language_code || "Неизвестен"}

✅ *Статус:* Авторизован
🔐 *Уровень доступа:* Администратор Matrix

*Примечание:* Ваш ID пользователя или имя пользователя находится в списке авторизованных для этого бота.
    `;

    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  })
);

// Команда быстрого поиска
bot.onText(
  /\/search (.+)/,
  requireAuth(async (msg, match) => {
    const chatId = msg.chat.id;
    const searchTerm = match[1].trim();

    const searchingMessage = await bot.sendMessage(
      chatId,
      `🔍 Поиск: "${searchTerm}"...`
    );

    try {
      const searchResults = await matrixClient.searchUsers(searchTerm);
      const users = searchResults.users || [];

      if (users.length === 0) {
        await bot.editMessageText(
          `🔍 *Результаты поиска*\n\nПользователи, соответствующие запросу "${searchTerm}", не найдены.\n\nПопробуйте поискать с другими условиями.`,
          {
            chat_id: chatId,
            message_id: searchingMessage.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔍 Новый поиск", callback_data: "search_users" }],
                [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
              ],
            },
          }
        );
        return;
      }

      // Сохраняем результаты поиска в состоянии пользователя
      userStates.set(chatId, {
        search_results: users,
        search_term: searchTerm,
        search_page: 0,
      });

      const resultMessage = `🔍 *Результаты поиска*\n\nНайдено ${searchResults.total} пользователей по запросу: "${searchTerm}"\n\nНажмите на пользователя для просмотра деталей или деактивации:`;

      await bot.editMessageText(resultMessage, {
        chat_id: chatId,
        message_id: searchingMessage.message_id,
        parse_mode: "Markdown",
        ...createSearchResultKeyboard(users, searchTerm, 0),
      });
    } catch (error) {
      await bot.editMessageText(
        `❌ *Ошибка поиска*\n\nОшибка: ${error.message}`,
        {
          chat_id: chatId,
          message_id: searchingMessage.message_id,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
            ],
          },
        }
      );
    }
  })
);

// Обработчик текстовых сообщений для ввода поиска
bot.on(
  "message",
  requireAuth(async (msg) => {
    // Пропускаем, если это команда или нет текста
    if (!msg.text || msg.text.startsWith("/")) {
      return;
    }

    const chatId = msg.chat.id;
    const userState = userStates.get(chatId);

    // Проверяем, находится ли пользователь в режиме ввода поиска
    if (userState && userState.waiting_for_search) {
      const searchTerm = msg.text.trim();

      if (!searchTerm) {
        bot.sendMessage(
          chatId,
          "❌ Пожалуйста, введите корректный поисковый запрос."
        );
        return;
      }

      const searchingMessage = await bot.sendMessage(
        chatId,
        `🔍 Поиск: "${searchTerm}"...`
      );

      try {
        const searchResults = await matrixClient.searchUsers(searchTerm);
        const users = searchResults.users || [];

        if (users.length === 0) {
          await bot.editMessageText(
            `🔍 *Результаты поиска*\n\nПользователи, соответствующие запросу "${searchTerm}", не найдены.\n\nПопробуйте поискать с другими условиями.`,
            {
              chat_id: chatId,
              message_id: searchingMessage.message_id,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔍 Новый поиск", callback_data: "search_users" }],
                  [
                    {
                      text: "🔙 В главное меню",
                      callback_data: "back_to_menu",
                    },
                  ],
                ],
              },
            }
          );

          // Очищаем состояние поиска
          userStates.delete(chatId);
          return;
        }

        // Обновляем состояние пользователя с результатами поиска
        userStates.set(chatId, {
          search_results: users,
          search_term: searchTerm,
          search_page: 0,
        });

        const resultMessage = `🔍 *Результаты поиска*\n\nНайдено ${searchResults.total} пользователей по запросу: "${searchTerm}"\n\nНажмите на пользователя для просмотра деталей или деактивации:`;

        await bot.editMessageText(resultMessage, {
          chat_id: chatId,
          message_id: searchingMessage.message_id,
          parse_mode: "Markdown",
          ...createSearchResultKeyboard(users, searchTerm, 0),
        });
      } catch (error) {
        await bot.editMessageText(
          `❌ *Ошибка поиска*\n\nОшибка: ${error.message}`,
          {
            chat_id: chatId,
            message_id: searchingMessage.message_id,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
              ],
            },
          }
        );

        // Очищаем состояние поиска
        userStates.delete(chatId);
      }
    }
  })
);

// Обработчик callback запросов с авторизацией
bot.on(
  "callback_query",
  requireAuthCallback(async (callbackQuery) => {
    const message = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = message.chat.id;
    const messageId = message.message_id;
    const user = callbackQuery.from;

    // Отвечаем на callback запрос немедленно, чтобы предотвратить таймаут
    try {
      await bot.answerCallbackQuery(callbackQuery.id);
    } catch (answerError) {
      console.error("Ошибка ответа на callback запрос:", answerError.message);
    }

    try {
      if (data === "show_my_info") {
        const userInfo = `${user.first_name || ""} ${
          user.last_name || ""
        }`.trim();
        const username = user.username
          ? `@${user.username}`
          : "Нет имени пользователя";

        const infoMessage = `
🔒 *Информация о вашей авторизации*

*Имя:* ${userInfo}
*Имя пользователя:* ${username}
*ID пользователя:* \`${user.id}\`

✅ *Статус:* Авторизован
🔐 *Уровень доступа:* Администратор Matrix
            `;

        await bot.editMessageText(infoMessage, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
            ],
          },
        });
      } else if (data === "search_users") {
        await bot.editMessageText(
          "🔍 *Поиск пользователей*\n\nПожалуйста, введите поисковый запрос (имя, отображаемое имя или ID пользователя):\n\nВведите ваш поисковый запрос и отправьте его как сообщение.",
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
              ],
            },
          }
        );

        // Устанавливаем состояние пользователя для ожидания ввода поиска
        userStates.set(chatId, { waiting_for_search: true });
      } else if (data.startsWith("search_page_")) {
        const page = parseInt(data.split("_")[2]);
        const state = userStates.get(chatId);

        if (state && state.search_results) {
          state.search_page = page;
          userStates.set(chatId, state);

          await bot.editMessageReplyMarkup(
            createSearchResultKeyboard(
              state.search_results,
              state.search_term,
              page
            ).reply_markup,
            { chat_id: chatId, message_id: messageId }
          );
        }
      } else if (data.startsWith("userinfo_")) {
        const userId = data.substring("userinfo_".length);

        try {
          const userInfo = await matrixClient.getUserInfo(userId);

          const infoMessage = `
👤 *Информация о пользователе*

*ID пользователя:* \`${userInfo.name}\`
*Отображаемое имя:* ${userInfo.displayname || "Не установлено"}
*Статус:* ${userInfo.deactivated ? "❌ Деактивирован" : "✅ Активен"}
*Администратор:* ${userInfo.admin ? "👑 Да" : "❌ Нет"}
*Тип пользователя:* ${userInfo.user_type || "обычный"}
*Время создания:* ${new Date(userInfo.creation_ts * 1000).toLocaleString(
            "ru-RU"
          )}
*Последний вход:* ${
            userInfo.last_seen_ts
              ? new Date(userInfo.last_seen_ts).toLocaleString("ru-RU")
              : "Неизвестно"
          }
                `;

          const buttons = [];
          if (userInfo.deactivated) {
            buttons.push([
              {
                text: "❌ Пользователь уже деактивирован",
                callback_data: "noop",
              },
            ]);
          } else if (userInfo.admin) {
            buttons.push([
              {
                text: "👑 Администратор защищен от деактивации",
                callback_data: "noop",
              },
            ]);
          } else {
            buttons.push([
              {
                text: "🗑️ Деактивировать пользователя",
                callback_data: `deactivate_${userId}`,
              },
            ]);
          }

          buttons.push([
            { text: "🔙 Назад к поиску", callback_data: "back_to_search" },
          ]);
          buttons.push([
            { text: "🏠 Главное меню", callback_data: "back_to_menu" },
          ]);

          await bot.editMessageText(infoMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: buttons,
            },
          });
        } catch (error) {
          await bot.editMessageText(
            `❌ *Ошибка получения информации о пользователе*\n\nОшибка: ${error.message}`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔙 В главное меню",
                      callback_data: "back_to_menu",
                    },
                  ],
                ],
              },
            }
          );
        }
      } else if (data === "back_to_search") {
        const state = userStates.get(chatId);
        if (state && state.search_results) {
          const resultMessage = `🔍 *Результаты поиска*\n\nНайдено ${state.search_results.length} пользователей по запросу: "${state.search_term}"\n\nНажмите на пользователя для просмотра деталей или деактивации:`;

          await bot.editMessageText(resultMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            ...createSearchResultKeyboard(
              state.search_results,
              state.search_term,
              state.search_page || 0
            ),
          });
        } else {
          await bot.editMessageText("Выберите действие:", {
            chat_id: chatId,
            message_id: messageId,
            ...createMainKeyboard(),
          });
        }
      } else if (data === "get_users") {
        await bot.editMessageText(
          "🔄 Получение пользователей с сервера Matrix...",
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );

        const usersData = await matrixClient.getUsers();
        const users = usersData.users || [];

        if (users.length === 0) {
          await bot.editMessageText("ℹ️ Пользователи на сервере не найдены.", {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
              ],
            },
          });
          return;
        }

        let usersList = `👥 *Пользователи на сервере Matrix* (всего ${users.length})\n\n`;
        users.forEach((user, index) => {
          const status = user.deactivated ? "❌ Деактивирован" : "✅ Активен";
          const userType = user.admin
            ? " (Администратор)"
            : user.user_type
            ? ` (${user.user_type})`
            : "";
          usersList += `${index + 1}. ${
            user.displayname || user.name
          }${userType}\n`;
          usersList += `   └ ${user.name} - ${status}\n\n`;
        });

        // Разделяем сообщение, если оно слишком длинное
        if (usersList.length > 1000) {
          usersList = usersList.substring(0, 980) + "...\n\n_Список сокращен_";
        }

        await bot.editMessageText(usersList, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
            ],
          },
        });
      } else if (data === "deactivate_menu") {
        await bot.editMessageText(
          "🔄 Загрузка пользователей для деактивации...",
          {
            chat_id: chatId,
            message_id: messageId,
          }
        );

        const usersData = await matrixClient.getUsers();
        // Фильтруем деактивированных пользователей И администраторов для безопасности
        const deactivatableUsers = (usersData.users || []).filter(
          (user) => !user.deactivated && !user.admin
        );

        if (deactivatableUsers.length === 0) {
          const totalActive = (usersData.users || []).filter(
            (user) => !user.deactivated
          ).length;
          const adminCount = (usersData.users || []).filter(
            (user) => !user.deactivated && user.admin
          ).length;

          let message = "ℹ️ Нет пользователей для деактивации.";
          if (adminCount > 0) {
            message += `\n\n👑 Найдено ${adminCount} администратор(ов), которые не могут быть деактивированы по соображениям безопасности.`;
          }

          await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
              ],
            },
          });
          return;
        }

        userStates.set(chatId, { users: deactivatableUsers, page: 0 });

        await bot.editMessageText(
          "❌ *Выберите пользователя для деактивации:*\n\n⚠️ Администраторы защищены и не отображаются в этом списке.",
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            ...createUserSelectionKeyboard(deactivatableUsers, 0),
          }
        );
      } else if (data.startsWith("deactivate_page_")) {
        const page = parseInt(data.split("_")[2]);
        const state = userStates.get(chatId);

        if (state && state.users) {
          state.page = page;
          userStates.set(chatId, state);

          await bot.editMessageReplyMarkup(
            createUserSelectionKeyboard(state.users, page).reply_markup,
            { chat_id: chatId, message_id: messageId }
          );
        }
      } else if (data.startsWith("deactivate_")) {
        const userId = data.substring("deactivate_".length);

        await bot.editMessageText(
          `⚠️ *Подтверждение деактивации*\n\nВы уверены, что хотите деактивировать пользователя:\n\`${userId}\`\n\n⚠️ Это действие нельзя отменить!`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "✅ Да, деактивировать",
                    callback_data: `confirm_deactivate_${userId}`,
                  },
                  { text: "❌ Отмена", callback_data: "deactivate_menu" },
                ],
              ],
            },
          }
        );
      } else if (data.startsWith("confirm_deactivate_")) {
        const userId = data.substring("confirm_deactivate_".length);

        await bot.editMessageText(`🔄 Деактивация пользователя ${userId}...`, {
          chat_id: chatId,
          message_id: messageId,
        });

        try {
          await matrixClient.deactivateUser(userId);

          // Логируем деактивацию
          const userInfo = `${user.first_name || ""} ${
            user.last_name || ""
          }`.trim();
          const username = user.username
            ? `@${user.username}`
            : "нет имени пользователя";
          console.log(
            `🔴 Пользователь деактивирован авторизованным администратором:`
          );
          console.log(`   Администратор: ${userInfo} (${username})`);
          console.log(`   ID администратора: ${user.id}`);
          console.log(`   Деактивирован: ${userId}`);
          console.log(`   Время: ${new Date().toISOString()}`);

          await bot.editMessageText(
            `✅ *Пользователь успешно деактивирован*\n\nПользователь \`${userId}\` был деактивирован.`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "❌ Деактивировать другого",
                      callback_data: "deactivate_menu",
                    },
                  ],
                  [
                    {
                      text: "🔙 В главное меню",
                      callback_data: "back_to_menu",
                    },
                  ],
                ],
              },
            }
          );
        } catch (error) {
          await bot.editMessageText(
            `❌ *Ошибка деактивации*\n\nОшибка: ${error.message}`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: "🔄 Попробовать снова",
                      callback_data: "deactivate_menu",
                    },
                  ],
                  [
                    {
                      text: "🔙 В главное меню",
                      callback_data: "back_to_menu",
                    },
                  ],
                ],
              },
            }
          );
        }
      } else if (data === "back_to_menu") {
        userStates.delete(chatId);
        await bot.editMessageText("Выберите действие:", {
          chat_id: chatId,
          message_id: messageId,
          ...createMainKeyboard(),
        });
      } else if (data === "noop") {
        // Ничего не делаем, просто отвечаем на callback
        return;
      }
    } catch (error) {
      console.error("Ошибка callback запроса:", error);
      await bot.editMessageText(`❌ Ошибка: ${error.message}`, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔙 В главное меню", callback_data: "back_to_menu" }],
          ],
        },
      });
    }
  })
);

// Обработка ошибок
bot.on("error", (error) => {
  console.error("Ошибка бота:", error);
});

// Стартовое сообщение с информацией о безопасности
console.log(
  "🤖 Бот администрирования Matrix Synapse (Русская версия) запущен..."
);
console.log("🔒 Конфигурация безопасности:");
console.log(
  `   Авторизованные ID пользователей: ${
    AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS.join(", ") : "Нет"
  }`
);
console.log(
  `   Авторизованные имена пользователей: ${
    AUTHORIZED_USERNAMES.length > 0 ? AUTHORIZED_USERNAMES.join(", ") : "Нет"
  }`
);

if (AUTHORIZED_USERS.length === 0 && AUTHORIZED_USERNAMES.length === 0) {
  console.error(
    "⚠️  ВНИМАНИЕ: Не настроены авторизованные пользователи! Бот запретит весь доступ."
  );
  console.error(
    "   Пожалуйста, установите AUTHORIZED_USERS или AUTHORIZED_USERNAMES в вашем файле .env"
  );
}

process.on("SIGINT", () => {
  console.log("Остановка бота...");
  bot.stopPolling();
  process.exit(0);
});
