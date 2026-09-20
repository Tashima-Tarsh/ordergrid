(()=>{
  const header=document.querySelector('header .head-actions');if(!header)return;
  const esc=value=>{const d=document.createElement('div');d.textContent=String(value??'');return d.innerHTML};
  const button=document.createElement('button');
  button.type='button';button.className='secondary notification-bell';button.id='notificationBell';
  button.innerHTML='Notifications <span id="notificationCount">0</span>';
  const anchor=document.querySelector('#controlCenterTop');header.insertBefore(button,anchor||header.firstChild);

  const panel=document.createElement('div');
  panel.id='notificationPanel';panel.className='notification-panel';panel.hidden=true;
  panel.innerHTML=`
    <div class="notification-head"><div><p class="eyebrow">ORDERGRID ALERTS</p><strong>Notifications</strong></div><button type="button" class="secondary" id="notificationClose">×</button></div>
    <div class="notification-tools"><button type="button" class="secondary" id="enableBrowserAlerts">Enable browser alerts</button><button type="button" class="secondary" id="markNotificationsRead">Mark all read</button></div>
    <div id="notificationList" class="notification-list"><p class="muted">No notifications yet.</p></div>`;
  document.body.appendChild(panel);

  const style=document.createElement('style');
  style.textContent=`
    .notification-bell{position:relative}.notification-bell span{display:inline-grid;place-items:center;min-width:20px;height:20px;margin-left:5px;padding:0 5px;border-radius:999px;background:#0f172a;color:#fff;font-size:10px;font-weight:900}
    .notification-panel{position:fixed;z-index:90;top:72px;right:24px;width:min(430px,calc(100vw - 32px));max-height:72vh;overflow:hidden;border:1px solid #dbe4eb;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.2)}
    .notification-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #edf2f7}.notification-head strong{display:block;margin-top:2px;color:#0f172a;font-size:17px}.notification-head button{padding:.45rem .65rem}
    .notification-tools{display:flex;gap:8px;padding:10px 14px;border-bottom:1px solid #edf2f7;background:#f8fafc}.notification-tools button{font-size:11px}
    .notification-list{max-height:56vh;overflow:auto}.notification-row{display:grid;grid-template-columns:10px 1fr auto;gap:10px;padding:13px 15px;border-bottom:1px solid #edf2f7;cursor:pointer}.notification-row:hover{background:#f8fbff}.notification-row .dot{width:8px;height:8px;border-radius:50%;margin-top:6px;background:#cbd5e1}.notification-row.unread .dot{background:#10b981}.notification-row strong,.notification-row span,.notification-row small{display:block}.notification-row strong{color:#0f172a;font-size:12px}.notification-row span{margin-top:3px;color:#475569;font-size:11px;line-height:1.45}.notification-row small{margin-top:4px;color:#94a3b8;font-size:9px}.notification-row time{color:#94a3b8;font-size:9px;white-space:nowrap}
    @media(max-width:600px){.notification-panel{top:64px;right:12px;width:calc(100vw - 24px)}}
  `;
  document.head.appendChild(style);

  let rows=[],known=new Set(),firstLoad=true;
  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  function render(){
    const unread=rows.filter(x=>!x.read_at).length;
    document.querySelector('#notificationCount').textContent=String(unread);
    document.querySelector('#notificationList').innerHTML=rows.length?rows.map(n=>`
      <article class="notification-row ${n.read_at?'':'unread'}" data-notification-id="${esc(n.id)}">
        <span class="dot"></span>
        <div><strong>${esc(n.title)}</strong><span>${esc(n.message)}</span><small>${esc(String(n.type||'').replaceAll('_',' '))}</small></div>
        <time>${new Date(n.created_at).toLocaleString('en-IN',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time>
      </article>`).join(''):'<p class="muted" style="padding:22px">No notifications yet.</p>';
  }
  async function load(){
    try{
      const data=await request('/api/notifications?limit=50');rows=data.notifications||[];
      for(const n of rows){
        if(!firstLoad&&!known.has(n.id)&&!n.read_at&&window.Notification?.permission==='granted'){
          try{new Notification(n.title,{body:n.message,tag:n.id})}catch{}
        }
        known.add(n.id);
      }
      firstLoad=false;render();
    }catch(error){console.error(error)}
  }
  button.onclick=()=>{panel.hidden=!panel.hidden;if(!panel.hidden)load()};
  document.querySelector('#notificationClose').onclick=()=>{panel.hidden=true};
  document.querySelector('#enableBrowserAlerts').onclick=async()=>{
    if(!('Notification' in window)){alert('Browser notifications are not supported here.');return}
    const permission=await Notification.requestPermission();
    if(permission==='granted'&&window.toast)window.toast('Browser alerts enabled');
  };
  document.querySelector('#markNotificationsRead').onclick=async()=>{
    try{await request('/api/notifications/read-all',{method:'POST'});await load()}catch(error){alert(error.message)}
  };
  document.querySelector('#notificationList').onclick=async event=>{
    const row=event.target.closest('[data-notification-id]');if(!row)return;
    try{await request('/api/notifications/'+encodeURIComponent(row.dataset.notificationId)+'/read',{method:'PATCH'});await load()}catch(error){console.error(error)}
  };
  window.addEventListener('ordergrid:update',load);
  setInterval(load,10000);
  load();
})();