import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import uk from './uk.json'

const supportedLngs = ['en', 'uk']
const systemLng = navigator.language.split('-')[0]
const detectedLng = supportedLngs.includes(systemLng) ? systemLng : 'en'

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, uk: { translation: uk } },
  lng: detectedLng,
  fallbackLng: 'en',
  interpolation: { escapeValue: false }
})

export default i18n
