/**
 * Скрипт авторизации в Telegram (чистая сессия)
 * Запуск: npx ts-node scripts/logout-and-auth.ts
 *
 * ВАЖНО: client.start() автоматически:
 * 1. Подключается к Telegram (connect)
 * 2. Отправляет код на телефон (sendCode)
 * 3. Ждёт ввод кода через phoneCode callback
 * 4. Обрабатывает 2FA через password callback
 *
 * НЕ нужно вручную вызывать connect() или sendCode()!
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import prompts from 'prompts';

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';

async function main() {
  console.log('=== Telegram Fresh Authentication ===\n');

  if (!API_ID || !API_HASH) {
    console.error('Ошибка: Установите TELEGRAM_API_ID и TELEGRAM_API_HASH в .env');
    process.exit(1);
  }

  console.log('API_ID:', API_ID);
  console.log('API_HASH:', API_HASH.substring(0, 8) + '...');

  // Получаем номер телефона заранее
  const { phone: rawPhone } = await prompts({
    name: 'phone',
    type: 'text',
    message: 'Введите номер телефона (например: +79001234567):',
  });

  if (!rawPhone) {
    console.error('Номер телефона обязателен');
    process.exit(1);
  }

  // Нормализуем номер - gramJS ожидает формат с + (международный)
  let phone = rawPhone.trim();
  // Если ввели без +, добавляем
  if (!phone.startsWith('+')) {
    phone = '+' + phone;
  }
  // Убираем пробелы и дефисы
  phone = phone.replace(/[\s\-\(\)]/g, '');

  console.log('Нормализованный номер:', phone);

  // ВАЖНО: Пустая StringSession для новой авторизации
  const stringSession = new StringSession('');

  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
    // Включаем подробное логирование для отладки
    baseLogger: {
      canSend(level: string) { return true; },
      log(level: string, message: string, color: string) {
        console.log(`[${level}] ${message}`);
      },
      setLevel(level: string) {},
      warn: console.warn,
      info: console.info,
      debug: console.debug,
      error: console.error,
    } as any,
  });

  console.log('\nНачинаем авторизацию...');
  console.log('(client.start() автоматически отправит код на телефон)\n');

  try {
    await client.start({
      // Возвращаем номер телефона
      phoneNumber: async () => {
        console.log('Отправка запроса на код для номера:', phone);
        return phone;
      },

      // ВАЖНО: Этот callback вызывается ПОСЛЕ того, как Telegram уже отправил код
      // Просто ждём ввод пользователя и возвращаем код
      phoneCode: async (isCodeViaApp) => {
        console.log('\n📱 Код отправлен!');
        console.log('isCodeViaApp:', isCodeViaApp);
        if (isCodeViaApp) {
          console.log('Код должен прийти В ПРИЛОЖЕНИЕ Telegram');
        } else {
          console.log('Код должен прийти по SMS или звонком');
        }
        console.log('');

        const response = await prompts({
          name: 'code',
          type: 'text',
          message: 'Введите код из Telegram:',
        });

        if (!response.code) {
          throw new Error('Код не введён');
        }

        return response.code;
      },

      // Callback для 2FA пароля (если включен)
      password: async () => {
        console.log('\n🔐 Требуется облачный пароль (2FA)');

        const response = await prompts({
          name: 'password',
          type: 'password',
          message: 'Введите облачный пароль:',
        });

        if (!response.password) {
          throw new Error('Пароль не введён');
        }

        return response.password;
      },

      // НЕ используем forceSMS - пусть Telegram сам выберет способ
      // forceSMS вызывает auth.ResendCode который может быть заблокирован

      // Обработка ошибок
      onError: (err) => {
        console.error('\n❌ Ошибка авторизации:', err.message);

        // Подсказки по типичным ошибкам
        if (err.message.includes('PHONE_CODE_EXPIRED')) {
          console.error('Код истёк. Запустите скрипт заново.');
        } else if (err.message.includes('PHONE_CODE_INVALID')) {
          console.error('Неверный код. Проверьте правильность ввода.');
        } else if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
          console.error('Требуется 2FA пароль.');
        } else if (err.message.includes('FLOOD_WAIT')) {
          const match = err.message.match(/FLOOD_WAIT_(\d+)/);
          if (match) {
            const seconds = parseInt(match[1], 10);
            console.error(`Слишком много попыток. Подождите ${seconds} секунд.`);
          }
        }

        throw err;
      },
    });

    console.log('\n✅ Успешно авторизован!');

    // Получаем session string для сохранения
    const sessionString = client.session.save() as unknown as string;

    console.log('\n=== SESSION STRING (для .env) ===');
    console.log(sessionString);
    console.log('=================================\n');
    console.log('Добавьте в .env:');
    console.log(`TELEGRAM_SESSION_STRING=${sessionString}\n`);

    // Опционально: показываем информацию о пользователе
    const me = await client.getMe();
    if (me && 'firstName' in me) {
      console.log(`Вошли как: ${me.firstName} ${me.lastName || ''}`);
      if ('username' in me && me.username) {
        console.log(`Username: @${me.username}`);
      }
    }

    await client.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('\n💥 Критическая ошибка:', err);
    await client.disconnect().catch(() => {});
    process.exit(1);
  }
}

main();
