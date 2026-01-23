# Server Setup

Подготовка сервера и установка Docker для PKG.

---

## Подготовка сервера

### 1. Подключение к серверу

```bash
ssh root@your-server-ip
```

### 2. Обновление системы

```bash
apt update && apt upgrade -y
```

### 3. Создание пользователя для деплоя

```bash
# Создать пользователя
adduser deploy
usermod -aG sudo deploy

# Настроить SSH ключи
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# Переключиться на нового пользователя
su - deploy
```

### 4. Настройка Firewall (UFW)

```bash
# Включить UFW
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Разрешить SSH (важно сделать до включения!)
sudo ufw allow ssh

# Разрешить HTTP и HTTPS
sudo ufw allow http
sudo ufw allow https

# Включить firewall
sudo ufw enable

# Проверить статус
sudo ufw status
```

### 5. Настройка Fail2ban (защита от brute-force)

```bash
sudo apt install fail2ban -y
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

---

## Установка Docker

### 1. Установка Docker Engine

```bash
# Удалить старые версии
sudo apt remove docker docker-engine docker.io containerd runc 2>/dev/null

# Установить зависимости
sudo apt install -y ca-certificates curl gnupg

# Добавить GPG ключ Docker
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Добавить репозиторий
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Установить Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Добавить пользователя в группу docker
sudo usermod -aG docker deploy

# Перелогиниться для применения групп
exit
ssh deploy@your-server-ip
```

### 2. Проверка установки

```bash
docker --version
docker compose version
docker run hello-world
```
