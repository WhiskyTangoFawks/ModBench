using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.Index;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.TestSupport;

/// <summary>The write API with the projection behind it. ADR-0014 makes the write and the Index
/// learning of it two events, so a test reading after a write lets the projector catch up
/// first.</summary>
internal sealed class ProjectingEditService(IndexProjector index, IServiceProvider handlers)
{
    /// <summary>The service every test writes through, over <paramref name="index"/>'s own store and
    /// schemas, reading the load order from the holder the Index was built with.</summary>
    internal static ProjectingEditService Over(IndexProjector index, LoadOrderHolder holder) =>
        new(index, TestEditService.Over(holder));

    internal RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope) =>
        Projected(Current<EditRecordHandler>().Edit(plugin, formKey, envelope));

    internal RecordEditResult Set(PluginKey plugin, string formKey, string member, JsonElement value) =>
        Projected(Current<EditRecordHandler>().Set(plugin, formKey, member, value));

    internal RecordEditResult DeleteRecord(PluginKey plugin, string formKey) =>
        Projected(Current<DeleteRecordHandler>().DeleteRecord(plugin, formKey));

    internal RecordEditResult CreateRecord(
        PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null) =>
        Projected(Current<CreateRecordHandler>().CreateRecord(plugin, recordType, editorId, requestedFormKey));

    internal RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin) =>
        Projected(Current<CopyRecordAsOverrideHandler>()
            .CopyRecordAsOverride(sourcePlugin, formKey, destinationPlugin));

    internal RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null) =>
        Projected(Current<CopyRecordAsNewRecordHandler>()
            .CopyRecordAsNewRecord(sourcePlugin, formKey, destinationPlugin, requestedFormKey));

    internal RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null) =>
        Projected(Current<RenumberRecordHandler>().RenumberRecord(plugin, formKey, requestedFormKey));

    /// <summary>A read, so nothing follows it.</summary>
    internal RecordEditResult PeekNextFreeFormKey(PluginKey plugin) =>
        Current<PeekNextFreeFormKeyHandler>().PeekNextFreeFormKey(plugin);

    private T Current<T>() where T : notnull => handlers.GetRequiredService<T>();

    private RecordEditResult Projected(RecordEditResult result)
    {
        index.Settle();
        return result;
    }
}
