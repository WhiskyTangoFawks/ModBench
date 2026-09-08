using System.Text.Json;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Microsoft.Extensions.DependencyInjection;

namespace MEditService.Tests.TestSupport;

/// <summary>The write API with the projection behind it. ADR-0046 makes the write and the Index
/// learning of it two events, so a test reading after a write lets the projector catch up
/// first.</summary>
internal sealed class ProjectingEditService(
    IndexProjector index, LoadOrderHolder holder, IServiceProvider handlers)
{
    /// <summary>The service every test writes through, over <paramref name="index"/>'s own store and
    /// schemas.</summary>
    internal static ProjectingEditService Over(IndexProjector index)
    {
        var holder = TestEditService.HolderOver(index);
        return new ProjectingEditService(index, holder, TestEditService.Over(holder));
    }

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

    // The two load orders are one in the product, where a snapshot reaches the holder and the Index
    // together; here the Index is the one a test reconciles, so the holder follows it per gesture.
    private T Current<T>() where T : notnull
    {
        TestEditService.Sync(holder, index);
        return handlers.GetRequiredService<T>();
    }

    private RecordEditResult Projected(RecordEditResult result)
    {
        index.Settle();
        return result;
    }
}
