import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { FeatureGuard } from "./FeatureGuard";
import { Login } from "@/pages/Login";
import { SetPassword } from "@/pages/SetPassword";
import { Dashboard } from "@/pages/Dashboard";
import { OrdersList, OrderDetail } from "@/pages/Orders";
import { InvoicesList, InvoiceDetail } from "@/pages/Invoices";
import { Approvals } from "@/pages/Approvals";
import { Payments } from "@/pages/Payments";
import { Exports } from "@/pages/Exports";
import { Audit } from "@/pages/Audit";
import { CompaniesList, CompanyDetail } from "@/pages/Companies";
import { Users } from "@/pages/Users";
import { Suppliers } from "@/pages/Suppliers";

// Replica la estructura de `function GP()` del bundle original:
// rutas publicas + rutas privadas agrupadas por requiredFeature.
export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/set-password", element: <SetPassword /> },
  {
    element: <FeatureGuard />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <Dashboard /> },
          {
            element: <FeatureGuard requiredFeature="orders.read" />,
            children: [
              { path: "orders", element: <OrdersList /> },
              { path: "orders/:orderId", element: <OrderDetail /> },
            ],
          },
          {
            element: <FeatureGuard requiredFeature="invoices.read" />,
            children: [
              { path: "invoices", element: <InvoicesList /> },
              { path: "invoices/:invoiceId", element: <InvoiceDetail /> },
            ],
          },
          {
            element: <FeatureGuard requiredFeature="approvals.review" />,
            children: [{ path: "approvals", element: <Approvals /> }],
          },
          {
            element: <FeatureGuard requiredFeature="payments.read" />,
            children: [{ path: "payments", element: <Payments /> }],
          },
          {
            element: <FeatureGuard requiredFeature="exports.read" />,
            children: [{ path: "exports", element: <Exports /> }],
          },
          {
            element: <FeatureGuard requiredFeature="audit.read" />,
            children: [{ path: "audit", element: <Audit /> }],
          },
          {
            element: <FeatureGuard requiredFeature="companies.manage" />,
            children: [
              { path: "companies", element: <CompaniesList /> },
              { path: "companies/:companyId", element: <CompanyDetail /> },
            ],
          },
          {
            element: <FeatureGuard requiredFeature="users.manage" />,
            children: [{ path: "users", element: <Users /> }],
          },
          {
            element: <FeatureGuard requiredFeature="suppliers.manage" />,
            children: [{ path: "suppliers", element: <Suppliers /> }],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
