const page = location.pathname.split('/').pop() || 'index.html';
const initializers = { 'index.html': initHome, 'admin.html': initAdmin, 'booking.html': initBooking, 'order.html': initOrder, 'recover.html': initRecover, 'help.html': bindFaq };
if (initializers[page]) initializers[page]();
