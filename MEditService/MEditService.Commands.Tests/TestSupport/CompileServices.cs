using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The compile service around a load order a test already has. The value is snapshotted at
/// the call, as the process's own holder is when the endpoint runs.</summary>
public static class CompileServices
{
    public static PluginCompileService Over(LoadOrderSnapshot loadOrder, IPluginAdapter? adapter = null)
    {
        var holder = new LoadOrderHolder();
        holder.Apply(loadOrder);
        return new PluginCompileService(
            holder,
            SharedSchemaReflector.Instance,
            new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            adapter ?? new MutagenPluginAdapter(),
            new PluginWriter(NullLogger<PluginWriter>.Instance),
            NullLogger<PluginCompileService>.Instance);
    }
}
