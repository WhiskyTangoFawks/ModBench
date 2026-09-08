using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>The write side as the composition root builds it: the held load order, one resolver
/// per gesture over it, the codec and the schema.</summary>
internal static class TestEditService
{
    internal static EditRecordHandler EditHandler(LoadOrderHolder holder)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var targets = new WriteTargets(
            holder, new DefaultModImporter(), codec, SharedSchemaReflector.Instance, NullLogger<WriteTargets>.Instance);
        return new EditRecordHandler(
            targets, holder, Resolver, codec, SharedSchemaReflector.Instance, NullLogger<EditRecordHandler>.Instance);
    }

    internal static EditRecordHandler EditHandler(IndexProjector index) => EditHandler(HolderOver(index));

    internal static DeleteRecordHandler DeleteHandler(LoadOrderHolder holder) => new(
        new WriteTargets(
            holder, new DefaultModImporter(), new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            SharedSchemaReflector.Instance, NullLogger<WriteTargets>.Instance),
        NullLogger<DeleteRecordHandler>.Instance);

    internal static CreateRecordHandler CreateHandler(LoadOrderHolder holder)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var targets = new WriteTargets(
            holder, new DefaultModImporter(), codec, SharedSchemaReflector.Instance, NullLogger<WriteTargets>.Instance);
        return new CreateRecordHandler(
            targets, holder, codec, SharedSchemaReflector.Instance, NullLogger<CreateRecordHandler>.Instance);
    }

    internal static CreateRecordHandler CreateHandler(IndexProjector index) => CreateHandler(HolderOver(index));

    internal static CopyRecordAsOverrideHandler CopyAsOverrideHandler(LoadOrderHolder holder)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var targets = new WriteTargets(
            holder, new DefaultModImporter(), codec, SharedSchemaReflector.Instance, NullLogger<WriteTargets>.Instance);
        return new CopyRecordAsOverrideHandler(
            targets, new RecordCopy(SharedSchemaReflector.Instance, NullLogger.Instance, codec), holder, codec,
            NullLogger<CopyRecordAsOverrideHandler>.Instance);
    }

    internal static AbsorbExternalChangeHandler AbsorbHandler() =>
        new(NullLogger<AbsorbExternalChangeHandler>.Instance);

    internal static KeepExternalChangeHandler KeepHandler() =>
        new(SharedSchemaReflector.Instance, NullLogger<KeepExternalChangeHandler>.Instance);

    internal static PeekNextFreeFormKeyHandler PeekHandler(LoadOrderHolder holder) => new(
        new WriteTargets(
            holder, new DefaultModImporter(), new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            SharedSchemaReflector.Instance, NullLogger<WriteTargets>.Instance),
        holder);

    internal static RecordEditService Over(LoadOrderHolder holder) =>
        new(holder, new DefaultModImporter(), new RecordTextCodec(NullLogger<RecordTextCodec>.Instance),
            SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    /// <summary>The same service for a test holding the Index: its held copies are the load order
    /// value the write side reads, and the Index itself never reaches the service.</summary>
    internal static RecordEditService Over(IndexProjector index) => Over(HolderOver(index));

    /// <summary>A holder carrying whatever <paramref name="index"/> holds right now — reapplied per
    /// gesture, since a test can register a copy mid-run.</summary>
    internal static LoadOrderHolder HolderOver(IndexProjector index)
    {
        var holder = new LoadOrderHolder();
        Sync(holder, index);
        return holder;
    }

    internal static void Sync(LoadOrderHolder holder, IndexProjector index)
    {
        if (index.LoadOrder is { } held) holder.Apply(LoadOrder.From(held));
    }

    private static FormLinkResolver Resolver(LoadOrder held) =>
        new(held, new DefaultModImporter(), SharedSchemaReflector.Instance);
}
