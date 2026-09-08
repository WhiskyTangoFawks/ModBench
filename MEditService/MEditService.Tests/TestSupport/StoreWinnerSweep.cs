using MEditService.Core.Plugins;
using MEditService.Core.Records;

namespace MEditService.Tests;

/// <summary>ADR-0044: the winner sweep is handed who participates, because the rule belongs to the
/// load order value. A store-level test states its load order as the registrations it writes, so
/// this reads those three facts back and applies <see cref="Registration.Participates"/> — the one
/// spelling of the rule — rather than making every call site restate the set.</summary>
internal static class StoreWinnerSweep
{
    internal static void UpdateWinners(this DuckDbRecordIndex store)
    {
        var participating = new List<RegisteredCopy>();
        using (var cmd = store.Connection.CreateCommand())
        {
            cmd.CommandText = "SELECT plugin, origin, load_order_idx, enabled, winning FROM registrations";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var registration = new Registration(
                    reader.IsDBNull(2) ? null : reader.GetInt32(2), reader.GetBoolean(3), reader.GetBoolean(4));
                if (registration.Participates)
                {
                    participating.Add(new RegisteredCopy(
                        reader.GetString(0), reader.GetString(1), Path: string.Empty,
                        registration.LoadOrderIndex, registration.Enabled, registration.Winning));
                }
            }
        }

        store.UpdateWinners(participating);
    }
}
