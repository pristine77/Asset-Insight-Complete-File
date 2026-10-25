import { THEME_COOKIE_KEY, THEME_STORAGE_KEY } from "./theme";

const source = `(function(){try{var k='${THEME_STORAGE_KEY}',c='${THEME_COOKIE_KEY}=',s=localStorage.getItem(k),m=document.cookie.split('; ').find(function(v){return v.indexOf(c)===0}),v=s||(m&&m.slice(c.length))||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(v!=='dark'&&v!=='light')v='light';document.documentElement.dataset.theme=v;document.documentElement.style.colorScheme=v}catch(e){}})()`;

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: source }} />;
}
