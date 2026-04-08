export type CartItem = {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
  productId: string;
};

const CART_KEY = "pedimos.customer.cart.v1";

export const cartState = {
  read(): CartItem[] {
    try {
      const raw = localStorage.getItem(CART_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as CartItem[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },

  write(items: CartItem[]): void {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  },

  add(item: CartItem): CartItem[] {
    const current = this.read();
    const existing = current.find((entry) => entry.productId === item.productId);
    if (existing) {
      existing.qty += 1;
      this.write([...current]);
      return [...current];
    }
    const next = [...current, item];
    this.write(next);
    return next;
  },

  clear(): void {
    localStorage.removeItem(CART_KEY);
  }
};
