/**
 * Скрипт для авторизации в Telegram
 * Запуск: npx ts-node scripts/auth.ts
 *
 * Основано на kostya-userbot
 */

import * as dotenv from 'dotenv';

// Загружаем .env из текущей директории (apps/telegram-adapter)
dotenv.config();

import { Api, TelegramClient } from 'telegram';
import { StoreSession, StringSession } from 'telegram/sessions';
import prompts from 'prompts';

// Конфигурация - можно задать через env или напрямую
let API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
let API_HASH = process.env.TELEGRAM_API_HASH || '';
const PHONE_NUMBER = process.env.TELEGRAM_PHONE_NUMBER || '';

// Путь для хранения сессии
const SESSION_PATH = './session_store';

async function askPassword(): Promise<string> {
  const response = await prompts({
    name: 'password',
    type: 'password',
    message: 'Введите облачный пароль (2FA):',
  });

  return response.password;
}

async function askPhone(): Promise<string> {
  if (PHONE_NUMBER) {
    return PHONE_NUMBER;
  }

  const response = await prompts({
    name: 'phone',
    type: 'text',
    message: 'Введите номер телефона (с +7):',
  });

  return response.phone;
}

async function askCode(client: TelegramClient, phoneNumber: string): Promise<string> {
  await client.connect();

  await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: phoneNumber,
      apiId: API_ID,
      apiHash: API_HASH,
      settings: new Api.CodeSettings({
        allowFlashcall: true,
        currentNumber: true,
        allowAppHash: true,
        allowMissedCall: true,
      }),
    }),
  );

  console.log('Код отправлен на номер', phoneNumber);

  const response = await prompts({
    name: 'code',
    type: 'text',
    message: 'Введите код из Telegram:',
  });

  return response.code;
}

async function main() {
  console.log('=== Telegram Authentication ===\n');

  if (!API_ID || !API_HASH) {
    console.error('Ошибка: Установите TELEGRAM_API_ID и TELEGRAM_API_HASH');
    console.error('Можно в .env файле или как переменные окружения\n');

    const config = await prompts([
      {
        name: 'apiId',
        type: 'number',
        message: 'Введите API_ID:',
      },
      {
        name: 'apiHash',
        type: 'text',
        message: 'Введите API_HASH:',
      },
    ]);

    if (!config.apiId || !config.apiHash) {
      console.error('API credentials обязательны');
      process.exit(1);
    }

    // Используем введенные значения
    API_ID = config.apiId;
    API_HASH = config.apiHash;
  }

  // Используем StoreSession для сохранения сессии на диск
  const storeSession = new StoreSession(SESSION_PATH);

  const client = new TelegramClient(storeSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  const phoneNumber = await askPhone();

  await client.start({
    phoneNumber: async () => phoneNumber,
    phoneCode: async () => await askCode(client, phoneNumber),
    password: async () => await askPassword(),
    onError: (err) => {
      console.error('Ошибка авторизации:', err.message);
      throw err;
    },
  });

  console.log('\n✅ Успешно авторизован!\n');

  // Получаем информацию о текущем пользователе
  const me = await client.getMe() as Api.User;
  console.log(`Вошли как: ${me.firstName} ${me.lastName || ''} (@${me.username || 'no username'})`);
  console.log(`User ID: ${me.id}\n`);

  // Сохраняем сессию
  await client.session.save();

  // Также выводим StringSession для использования в env
  const stringSession = new StringSession('');
  // @ts-ignore - получаем auth key из store session
  stringSession.setDC(client.session.dcId, client.session.serverAddress, client.session.port);
  // @ts-ignore
  stringSession.setAuthKey(client.session.getAuthKey());

  const sessionString = stringSession.save();

  console.log('=== SESSION STRING (для .env) ===');
  console.log(sessionString);
  console.log('=================================\n');

  console.log('Сессия сохранена в:', SESSION_PATH);
  console.log('\nДля использования добавьте в .env:');
  console.log(`TELEGRAM_SESSION_STRING=${sessionString}\n`);

  await client.disconnect();
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
