using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The one envelope, spelled once for the tests: every gesture is an operation, a path of
/// hops and an optional value (ADR-0005).</summary>
internal static class Envelopes
{
    internal static PathHop Member(string name) => new(PathHop.MemberKind, Name: name);
    internal static PathHop At(int index) => new(PathHop.IndexKind, Index: index);

    internal static EditValue ValueOf(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Number => new(EditValueKind.Number, element.GetRawText()),
        JsonValueKind.String => new(EditValueKind.Text, element.GetRawText(), element.GetString()),
        _ => new(EditValueKind.Other, element.GetRawText()),
    };

    internal static RecordEditEnvelope SetAt(JsonElement value, params PathHop[] path) =>
        new(RecordEditEnvelope.Set, path, ValueOf(value));

    /// <summary>A set of JSON null: the member is cleared and reads as its default (ADR-0005).</summary>
    internal static RecordEditEnvelope Clear(params PathHop[] path) =>
        new(RecordEditEnvelope.Set, path, new EditValue(EditValueKind.Other, "null"));

    internal static RecordEditEnvelope AddAt(params PathHop[] path) => new(RecordEditEnvelope.Add, path);

    internal static RecordEditEnvelope AddAt(JsonElement element, params PathHop[] path) =>
        new(RecordEditEnvelope.Add, path, ValueOf(element));

    internal static RecordEditEnvelope RemoveAt(params PathHop[] path) => new(RecordEditEnvelope.Remove, path);

    internal static RecordEditEnvelope MoveTo(int destination, params PathHop[] path) =>
        new(RecordEditEnvelope.Move, path, new EditValue(EditValueKind.Number, destination.ToString(System.Globalization.CultureInfo.InvariantCulture)));

    /// <summary>A set of one top-level member: the gesture most tests make.</summary>
    internal static RecordEditResult Set(
        this TestEditor handler, PluginAddress plugin, string formKey, string member, JsonElement value) =>
        handler.Edit(plugin, formKey, SetAt(value, Member(member)));

    /// <summary>A set of the record's FormID, which the document holds as its FormKey member.</summary>
    internal static RecordEditResult SetFormId(
        this TestEditor handler, PluginAddress plugin, string formKey, string newFormKey) =>
        handler.Set(plugin, formKey, "FormKey", JsonSerializer.SerializeToElement(newFormKey));
}
