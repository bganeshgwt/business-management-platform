// The delivery charge the till expects, worked out the way the
// server does (backend deliveryCharge.repository): the channel's charge,
// nothing from its "free above" amount on, and a delivery with no channel
// picked is the restaurant's own delivery. The server's figure is the one
// charged; this is what the cashier tells the guest before saving.
export const channelForCharge = (channels, channelId) => {
  const picked = channels.find((one) => String(one.id) === String(channelId));

  if (picked) {
    return picked;
  }

  return (
    channels
      .filter((one) => one.type === "own" && one.status === "active")
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id)[0] || null
  );
};

export const previewCharge = (channel, foodTotal) => {
  if (!channel || !(Number(channel.deliveryCharge) > 0)) {
    return { charge: 0, free: false, short: null };
  }

  const above = channel.deliveryFreeAbove;

  if (above && foodTotal >= above) {
    return { charge: 0, free: true, short: null };
  }

  return { charge: Number(channel.deliveryCharge), free: false, short: above ? above - foodTotal : null };
};

