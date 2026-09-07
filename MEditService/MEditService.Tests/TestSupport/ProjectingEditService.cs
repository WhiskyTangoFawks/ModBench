using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>The write API with the projection behind it. ADR-0046 makes the write and the Index
/// learning of it two events, so a test reading after a write lets the projector catch up
/// first.</summary>
internal sealed class ProjectingEditService(ILoadOrderMirror mirror, LoadOrderHolder holder, RecordEditService inner)
{
    /// <summary>The service every test writes through, over <paramref name="mirror"/>'s own index and
    /// schemas.</summary>
    internal static ProjectingEditService Over(ILoadOrderMirror mirror)
    {
        var holder = TestEditService.HolderOver(mirror);
        return new ProjectingEditService(mirror, holder, TestEditService.Over(holder, mirror));
    }

    internal RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope) =>
        Projected(Current().Edit(plugin, formKey, envelope));

    internal RecordEditResult Set(PluginKey plugin, string formKey, string member, JsonElement value) =>
        Projected(Current().Set(plugin, formKey, member, value));

    internal RecordEditResult DeleteRecord(PluginKey plugin, string formKey) =>
        Projected(Current().DeleteRecord(plugin, formKey));

    internal RecordEditResult CreateRecord(
        PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null) =>
        Projected(Current().CreateRecord(plugin, recordType, editorId, requestedFormKey));

    internal RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin) =>
        Projected(Current().CopyRecordAsOverride(sourcePlugin, formKey, destinationPlugin));

    internal RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null) =>
        Projected(Current().CopyRecordAsNewRecord(sourcePlugin, formKey, destinationPlugin, requestedFormKey));

    internal RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null) =>
        Projected(Current().RenumberRecord(plugin, formKey, requestedFormKey));

    /// <summary>A read, so nothing follows it.</summary>
    internal RecordEditResult PeekNextFreeFormKey(PluginKey plugin) => Current().PeekNextFreeFormKey(plugin);

    // The two load orders are one in the product, where a snapshot reaches the holder and the mirror
    // together; here the mirror is the one a test reconciles, so the holder follows it per gesture.
    private RecordEditService Current()
    {
        TestEditService.Sync(holder, mirror);
        return inner;
    }

    private RecordEditResult Projected(RecordEditResult result)
    {
        mirror.Settle();
        return result;
    }
}
