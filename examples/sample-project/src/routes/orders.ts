import { findOrdersByCustomer } from "../db/repository";

export async function listOrders(req: { params: { customerId: string } }) {
  return findOrdersByCustomer(req.params.customerId);
}
