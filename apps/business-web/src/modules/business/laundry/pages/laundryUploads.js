import api from "../../../../services/api";

// A picture added to a garment order (a photo of a garment at intake or at its
// quality check, or the customer's signature): fields { orderId, kind: photo |
// signature, itemId?, stage? }. The server checks the picture and who may add it.
export async function uploadLaundryFile(biz, fields, file) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) if (value !== undefined && value !== null && value !== "") form.append(name, String(value));
  form.append("file", file);
  return (await api.post(`/businesses/${biz.id}/laundry/files`, form)).data.data;
}
