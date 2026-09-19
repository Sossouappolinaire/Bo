// Compte administrateur intégré à l'application.
// Le mot de passe n'est pas stocké en clair : seul son hash bcrypt est inclus.
// Cela permet de démarrer le service sans variables ADMIN_* dans Render.
const ADMIN_EMAIL = 'sossoukouam@gmail.com';
const ADMIN_PASSWORD_HASH = '$2a$10$avJUW.bl9i9KlrcfyXNRX.F6N/KCyLEBkarRoeGBPWUyBWb0xIdYu';

module.exports = { ADMIN_EMAIL, ADMIN_PASSWORD_HASH };