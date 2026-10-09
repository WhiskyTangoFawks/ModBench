using System.Collections.Concurrent;
using MEditService.PluginAdapter;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>Real plugins, with the adapter saying a file has gone or changed while its bytes stay
/// as they are on disk. <paramref name="clock"/> decides when a file's stamp is settled enough to
/// keep its hash.</summary>
internal sealed class DiskSaysAdapter(TimeProvider? clock = null)
    : DelegatingPluginAdapter(new MutagenPluginAdapter(clock ?? TimeProvider.System))
{
    private const string ChangedHash = "changed";

    private readonly ConcurrentDictionary<string, bool> _gone = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, bool> _changed = new(StringComparer.Ordinal);

    public void Gone(string pluginPath) => _gone[pluginPath] = true;

    public void Changed(string pluginPath) => _changed[pluginPath] = true;

    public override bool Exists(string pluginPath) => !_gone.ContainsKey(pluginPath) && base.Exists(pluginPath);

    public override string? HashOf(string pluginPath) =>
        _changed.ContainsKey(pluginPath) ? ChangedHash : base.HashOf(pluginPath);

    public override FileClaim? ClaimOf(string pluginPath) =>
        _changed.ContainsKey(pluginPath) && base.ClaimOf(pluginPath) is { } claim
            ? claim with { Hash = ChangedHash }
            : base.ClaimOf(pluginPath);
}
