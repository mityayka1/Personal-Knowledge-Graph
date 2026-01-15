/**
 * Ручная авторизация с полным контролем каждого шага
 * Запуск: npx ts-node scripts/manual-auth.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import prompts from 'prompts';

const API_ID = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
const API_HASH = process.env.TELEGRAM_API_HASH || '';

async function main() {
  console.log('=== Manual Telegram Authentication ===\n');

  if (!API_ID || !API_HASH) {
    console.error('Ошибка: TELEGRAM_API_ID и TELEGRAM_API_HASH не установлены');
    process.exit(1);
  }

  console.log('API_ID:', API_ID);
  console.log('API_HASH:', API_HASH.substring(0, 8) + '...\n');

  // Получаем номер телефона
  const { rawPhone } = await prompts({
    name: 'rawPhone',
    type: 'text',
    message: 'Введите номер телефона (например +79001234567):',
  });

  if (!rawPhone) {
    console.error('Номер телефона обязателен');
    process.exit(1);
  }

  // Нормализуем номер
  let phone = rawPhone.trim().replace(/[\s\-\(\)]/g, '');
  if (!phone.startsWith('+')) {
    phone = '+' + phone;
  }
  console.log('Номер:', phone);

  // Создаём клиент с пустой сессией
  const session = new StringSession('');
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  console.log('\n[1/6] Подключение к Telegram...');
  await client.connect();
  console.log('✓ Подключено\n');

  console.log('[2/6] Отправка auth.SendCode...');
  let sendCodeResult: Api.auth.TypeSentCode;
  try {
    sendCodeResult = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: API_ID,
        apiHash: API_HASH,
        settings: new Api.CodeSettings({}),
      }),
    );
  } catch (err: any) {
    console.error('Ошибка SendCode:', err.message);
    if (err.message.includes('PHONE_NUMBER_INVALID')) {
      console.error('Неверный формат номера телефона');
    } else if (err.message.includes('PHONE_NUMBER_BANNED')) {
      console.error('Номер заблокирован');
    } else if (err.message.includes('FLOOD')) {
      console.error('Слишком много попыток, подождите');
    }
    await client.disconnect();
    process.exit(1);
  }

  console.log('✓ SendCode успешно');
  console.log('  Ответ:', sendCodeResult.className);

  // Проверяем тип ответа
  if (sendCodeResult instanceof Api.auth.SentCode) {
    console.log('  phoneCodeHash:', sendCodeResult.phoneCodeHash.substring(0, 10) + '...');
    console.log('  type:', sendCodeResult.type.className);

    if (sendCodeResult.type instanceof Api.auth.SentCodeTypeApp) {
      console.log('  → Код отправлен В ПРИЛОЖЕНИЕ Telegram');
      console.log('  → Длина кода:', sendCodeResult.type.length);
    } else if (sendCodeResult.type instanceof Api.auth.SentCodeTypeSms) {
      console.log('  → Код отправлен по SMS');
      console.log('  → Длина кода:', sendCodeResult.type.length);
    } else if (sendCodeResult.type instanceof Api.auth.SentCodeTypeCall) {
      console.log('  → Код будет передан звонком');
    } else if (sendCodeResult.type instanceof Api.auth.SentCodeTypeFlashCall) {
      console.log('  → Flash-call (последние цифры номера)');
    } else if (sendCodeResult.type instanceof Api.auth.SentCodeTypeMissedCall) {
      console.log('  → Missed call (последние цифры номера)');
    } else if (sendCodeResult.type instanceof Api.auth.SentCodeTypeFirebaseSms) {
      console.log('  → Firebase SMS');
    } else {
      console.log('  → Неизвестный тип:', sendCodeResult.type.className);
    }

    if (sendCodeResult.nextType) {
      console.log('  nextType:', sendCodeResult.nextType.className);
    }
    if (sendCodeResult.timeout) {
      console.log('  timeout:', sendCodeResult.timeout, 'сек');
    }
  } else if (sendCodeResult instanceof Api.auth.SentCodeSuccess) {
    console.log('  → Авторизация уже выполнена!');
    const auth = sendCodeResult.authorization;
    if (auth instanceof Api.auth.Authorization) {
      const user = auth.user as Api.User;
      console.log('  Пользователь:', user.firstName, user.lastName || '');
    }
    await client.disconnect();
    process.exit(0);
  }

  const sentCode = sendCodeResult as Api.auth.SentCode;
  const phoneCodeHash = sentCode.phoneCodeHash;

  // Предлагаем запросить SMS если код не приходит
  if (sentCode.timeout) {
    console.log(`\n  Можно запросить SMS через ${sentCode.timeout} сек`);
  }

  const { resend } = await prompts({
    name: 'resend',
    type: 'confirm',
    message: 'Запросить повторную отправку через SMS?',
    initial: false,
  });

  if (resend) {
    console.log('\n[2.5/6] Запрос повторной отправки (SMS)...');
    try {
      const resendResult = await client.invoke(
        new Api.auth.ResendCode({
          phoneNumber: phone,
          phoneCodeHash: phoneCodeHash,
        }),
      );
      console.log('✓ Повторная отправка:', resendResult.className);
      if (resendResult instanceof Api.auth.SentCode) {
        console.log('  Новый тип:', resendResult.type.className);
      }
    } catch (err: any) {
      console.error('Ошибка ResendCode:', err.message);
      if (err.message.includes('SEND_CODE_UNAVAILABLE')) {
        console.log('SMS недоступен, используйте код из приложения');
      }
    }
  }

  // Получаем код от пользователя
  console.log('\n[3/6] Ожидание кода...');
  const { code } = await prompts({
    name: 'code',
    type: 'text',
    message: 'Введите код из Telegram:',
  });

  if (!code) {
    console.error('Код не введён');
    await client.disconnect();
    process.exit(1);
  }

  console.log('\n[4/6] Отправка auth.SignIn...');
  let signInResult: Api.auth.TypeAuthorization | null = null;
  let needs2FA = false;

  try {
    signInResult = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: phoneCodeHash,
        phoneCode: code,
      }),
    );
    console.log('✓ SignIn успешно');
  } catch (err: any) {
    if (err.message.includes('SESSION_PASSWORD_NEEDED')) {
      console.log('✓ Требуется 2FA пароль');
      needs2FA = true;
    } else if (err.message.includes('PHONE_CODE_INVALID')) {
      console.error('Неверный код');
      await client.disconnect();
      process.exit(1);
    } else if (err.message.includes('PHONE_CODE_EXPIRED')) {
      console.error('Код истёк');
      await client.disconnect();
      process.exit(1);
    } else {
      console.error('Ошибка SignIn:', err.message);
      await client.disconnect();
      process.exit(1);
    }
  }

  // Обработка 2FA
  if (needs2FA) {
    console.log('\n[5/6] Получение параметров 2FA...');
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    console.log('✓ Параметры получены');
    console.log('  hasPassword:', passwordInfo.hasPassword);
    console.log('  hint:', passwordInfo.hint || '(нет подсказки)');

    const { password } = await prompts({
      name: 'password',
      type: 'password',
      message: `Введите облачный пароль${passwordInfo.hint ? ` (подсказка: ${passwordInfo.hint})` : ''}:`,
    });

    if (!password) {
      console.error('Пароль не введён');
      await client.disconnect();
      process.exit(1);
    }

    console.log('\n[6/6] Проверка пароля...');
    const passwordSrp = await computeCheck(passwordInfo, password);

    signInResult = await client.invoke(
      new Api.auth.CheckPassword({ password: passwordSrp }),
    );
    console.log('✓ Пароль верный');
  }

  // Успешная авторизация
  if (signInResult instanceof Api.auth.Authorization) {
    const user = signInResult.user as Api.User;
    console.log('\n✅ Авторизация успешна!');
    console.log('Пользователь:', user.firstName, user.lastName || '');
    console.log('Username:', user.username || '(нет)');
    console.log('ID:', user.id.toString());

    const sessionString = client.session.save() as unknown as string;
    console.log('\n=== SESSION STRING ===');
    console.log(sessionString);
    console.log('======================\n');
    console.log(`TELEGRAM_SESSION_STRING=${sessionString}`);
  }

  await client.disconnect();
}

main().catch((err) => {
  console.error('Критическая ошибка:', err);
  process.exit(1);
});
