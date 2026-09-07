using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>The write service as the composition root builds it: the held load order, one resolver
/// per gesture over it, the codec and the schema.</summary>
internal static class TestEditService
{
    internal static RecordEditService Over(LoadOrderHolder holder, ILoadOrderMirror? mirror = null) =>
        new(holder, Resolver, new DefaultModImporter(), new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance, mirror);

    /// <summary>The same service for a test still holding a mirror: its held copies are the load
    /// order value the write side reads.</summary>
    internal static RecordEditService Over(ILoadOrderMirror mirror) => Over(HolderOver(mirror), mirror);

    /// <summary>A holder carrying whatever <paramref name="mirror"/> holds right now — reapplied per
    /// gesture, since a test can register a copy mid-run.</summary>
    internal static LoadOrderHolder HolderOver(ILoadOrderMirror mirror)
    {
        var holder = new LoadOrderHolder();
        Sync(holder, mirror);
        return holder;
    }

    internal static void Sync(LoadOrderHolder holder, ILoadOrderMirror mirror)
    {
        if (mirror.LoadOrder is { } held) holder.Apply(LoadOrder.From(held));
    }

    private static FormLinkResolver Resolver(LoadOrder held) =>
        new(held, new DefaultModImporter(), SharedSchemaReflector.Instance);
}
