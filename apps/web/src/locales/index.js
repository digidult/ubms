import en from './en.json';
import uk from './uk.json';
import ru from './ru.json';
import de from './de.json';
import fr from './fr.json';
import kitUk from '@ubms/ui/locales/uk.json';
import kitRu from '@ubms/ui/locales/ru.json';
import kitDe from '@ubms/ui/locales/de.json';
import kitFr from '@ubms/ui/locales/fr.json';

/**
 * Register all translation catalogs. English source strings are the keys; `en.json` only holds
 * plural forms. The UI kit ships its own catalogs, the app catalogs cover the app, the BMS core
 * catalogs and the drivers.
 * @param {ReturnType<typeof import('@ubms/ui').createI18n>} i18n
 */
export function registerTranslations(i18n) {
  i18n.register('en', en);
  i18n.register('uk', { ...kitUk, ...uk });
  i18n.register('ru', { ...kitRu, ...ru });
  i18n.register('de', { ...kitDe, ...de });
  i18n.register('fr', { ...kitFr, ...fr });
}
