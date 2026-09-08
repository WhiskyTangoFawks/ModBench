using System.Text.Json;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.TestSupport;

/// <summary>The write API with the projection behind it. ADR-0046 makes the write and the Index
/// learning of it two events, so a test reading after a write lets the projector catch up
/// first.</summary>
internal sealed class ProjectingEditService(
    IndexProjector index, LoadOrderHolder holder, RecordEditService inner, EditRecordHandler edits,
    DeleteRecordHandler deletes, CreateRecordHandler creates, PeekNextFreeFormKeyHandler peek,
    CopyRecordAsOverrideHandler copyOverrides, CopyRecordAsNewRecordHandler copyAsNew)
{
    /// <summary>The service every test writes through, over <paramref name="index"/>'s own store and
    /// schemas.</summary>
    internal static ProjectingEditService Over(IndexProjector index)
    {
        var holder = TestEditService.HolderOver(index);
        return new ProjectingEditService(
            index, holder, TestEditService.Over(holder), TestEditService.EditHandler(holder),
            TestEditService.DeleteHandler(holder), TestEditService.CreateHandler(holder), TestEditService.PeekHandler(holder),
            TestEditService.CopyAsOverrideHandler(holder), TestEditService.CopyAsNewHandler(holder));
    }

    internal RecordEditResult Edit(PluginKey plugin, string formKey, RecordEditEnvelope envelope) =>
        Projected(CurrentEdits().Edit(plugin, formKey, envelope));

    internal RecordEditResult Set(PluginKey plugin, string formKey, string member, JsonElement value) =>
        Projected(CurrentEdits().Set(plugin, formKey, member, value));

    internal RecordEditResult DeleteRecord(PluginKey plugin, string formKey) =>
        Projected(CurrentDeletes().DeleteRecord(plugin, formKey));

    internal RecordEditResult CreateRecord(
        PluginKey plugin, string recordType, string? editorId, string? requestedFormKey = null) =>
        Projected(CurrentCreates().CreateRecord(plugin, recordType, editorId, requestedFormKey));

    internal RecordEditResult CopyRecordAsOverride(PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin) =>
        Projected(CurrentCopyOverrides().CopyRecordAsOverride(sourcePlugin, formKey, destinationPlugin));

    internal RecordEditResult CopyRecordAsNewRecord(
        PluginKey sourcePlugin, string formKey, PluginKey destinationPlugin, string? requestedFormKey = null) =>
        Projected(CurrentCopyAsNew().CopyRecordAsNewRecord(sourcePlugin, formKey, destinationPlugin, requestedFormKey));

    internal RecordEditResult RenumberRecord(PluginKey plugin, string formKey, string? requestedFormKey = null) =>
        Projected(Current().RenumberRecord(plugin, formKey, requestedFormKey));

    /// <summary>A read, so nothing follows it.</summary>
    internal RecordEditResult PeekNextFreeFormKey(PluginKey plugin) => CurrentPeek().PeekNextFreeFormKey(plugin);

    // The two load orders are one in the product, where a snapshot reaches the holder and the Index
    // together; here the Index is the one a test reconciles, so the holder follows it per gesture.
    private RecordEditService Current()
    {
        TestEditService.Sync(holder, index);
        return inner;
    }

    private EditRecordHandler CurrentEdits()
    {
        TestEditService.Sync(holder, index);
        return edits;
    }

    private DeleteRecordHandler CurrentDeletes()
    {
        TestEditService.Sync(holder, index);
        return deletes;
    }

    private CreateRecordHandler CurrentCreates()
    {
        TestEditService.Sync(holder, index);
        return creates;
    }

    private CopyRecordAsOverrideHandler CurrentCopyOverrides()
    {
        TestEditService.Sync(holder, index);
        return copyOverrides;
    }

    private CopyRecordAsNewRecordHandler CurrentCopyAsNew()
    {
        TestEditService.Sync(holder, index);
        return copyAsNew;
    }

    private PeekNextFreeFormKeyHandler CurrentPeek()
    {
        TestEditService.Sync(holder, index);
        return peek;
    }

    private RecordEditResult Projected(RecordEditResult result)
    {
        index.Settle();
        return result;
    }
}
