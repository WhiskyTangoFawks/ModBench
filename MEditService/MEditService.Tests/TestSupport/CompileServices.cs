using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>The compile service around a load order a test already has. The value is snapshotted at
/// the call, as the process's own holder is when the endpoint runs.</summary>
public static class CompileServices
{
    public static PluginCompileService Over(LoadOrder loadOrder)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        return new PluginCompileService(
            holder,
            SharedSchemaReflector.Instance,
            new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            new PluginWriter(NullLogger<PluginWriter>.Instance),
            NullLogger<PluginCompileService>.Instance);
    }

    /// <summary>The same, for a suite outside the compile suite that still holds the mirror: its
    /// load order as the value, read at the call.</summary>
    public static PluginCompileService Over(ILoadOrderMirror mirror) =>
        Over(LoadOrder.From(mirror.LoadOrder!));
}
