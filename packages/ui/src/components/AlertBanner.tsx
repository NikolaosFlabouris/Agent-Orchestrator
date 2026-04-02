interface Alert {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export function AlertBanner({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) return null;

  const colors = {
    info: 'bg-blue-900/50 border-blue-700 text-blue-200',
    warning: 'bg-yellow-900/50 border-yellow-700 text-yellow-200',
    error: 'bg-red-900/50 border-red-700 text-red-200',
  };

  return (
    <div className="px-6 pt-4 space-y-2">
      {alerts.map((alert, i) => (
        <div
          key={i}
          className={`border rounded px-4 py-2 text-sm ${colors[alert.level]}`}
        >
          {alert.message}
        </div>
      ))}
    </div>
  );
}
