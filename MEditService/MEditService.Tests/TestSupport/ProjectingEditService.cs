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
internal sealed class ProjectingEditService(ILoadOrderMirror mirror, RecordEditService inner)
{
    /// <summary>The service every test writes through, over <paramref name="mirror"/>'s own index and
    /// schemas.</summary>
    internal static ProjectingEditService Over(ILoadOrderMirror mirror) =>
        new(mirror, new RecordEditService(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance));

    internal RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope) =>
        Projected(inner.Edit(plugin, formKey, envelope));

    internal RecordEditResult Set(PluginKey plugin, string formKey, string member, JsonElement value) =>
        Projected(inner.Set(plugin, formKey, member, value));

    internal RecordEditResult DeleteRecord(PluginKey plugin, string formKey) =>
        Projected(inner.DeleteRecord(plugin, formKey));

    internal RecordEditResult CreateRecord(
        PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null) =>
        Projected(inner.CreateRecord(plugin, recordType, editorId, requestedFormKey));

    internal RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin) =>
        Projected(inner.CopyRecordAsOverride(sourcePlugin, formKey, destinationPlugin));

    internal RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null) =>
        Projected(inner.CopyRecordAsNewRecord(sourcePlugin, formKey, destinationPlugin, requestedFormKey));

    internal RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null) =>
        Projected(inner.RenumberRecord(plugin, formKey, requestedFormKey));

    /// <summary>A read, so nothing follows it.</summary>
    internal RecordEditResult PeekNextFreeFormKey(PluginKey plugin) => inner.PeekNextFreeFormKey(plugin);

    private RecordEditResult Projected(RecordEditResult result)
    {
        mirror.Settle();
        return result;
    }
}
