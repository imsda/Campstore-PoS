(function(root,factory){
 if(typeof module==='object'&&module.exports) module.exports=factory();
 else root.CampDateTime=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 const TIME_ZONE='America/Chicago';
 const dateTimeFormatter=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
 const dateFormatter=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,month:'numeric',day:'numeric',year:'numeric'});
 const timeFormatter=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,hour:'numeric',minute:'2-digit',hour12:true});
 const keyFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
 function parseDate(value){if(value instanceof Date)return Number.isNaN(value.getTime())?null:value; if(value===undefined||value===null||value==='')return null; const d=new Date(value); return Number.isNaN(d.getTime())?null:d}
 function now(){return new Date().toISOString()}
 function currentMillis(){return Date.now()}
 function formatDateTime(value){const d=parseDate(value); return d?dateTimeFormatter.format(d):String(value||'')}
 function formatDate(value){const d=parseDate(value); return d?dateFormatter.format(d):String(value||'')}
 function formatTime(value){const d=parseDate(value); return d?timeFormatter.format(d):String(value||'')}
 function getBusinessDateKey(value){const d=parseDate(value)||new Date(); return keyFormatter.format(d)}
 function getBusinessToday(){return getBusinessDateKey(new Date())}
 function isBusinessDate(value,key){return getBusinessDateKey(value)===key}
 function fileDateStamp(value){return getBusinessDateKey(value).replace(/-/g,'')}
 function relativeTime(value){const d=parseDate(value); if(!d)return value?'': 'Never'; const seconds=Math.max(0,Math.floor((Date.now()-d.getTime())/1000)); if(seconds<60)return'just now'; const minutes=Math.floor(seconds/60); if(minutes<60)return`${minutes} minute${minutes===1?'':'s'} ago`; const hours=Math.floor(minutes/60); if(hours<24)return`${hours} hour${hours===1?'':'s'} ago`; const days=Math.floor(hours/24); return`${days} day${days===1?'':'s'} ago`}
 return {TIME_ZONE,now,currentMillis,formatDateTime,formatDate,formatTime,getBusinessToday,getBusinessDateKey,isBusinessDate,fileDateStamp,relativeTime};
});
