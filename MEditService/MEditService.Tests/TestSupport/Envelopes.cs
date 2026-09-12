using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Tests.TestSupport;

/// <summary>The one envelope, spelled once for the tests: every gesture is an operation, a path of
/// hops and an optional value (ADR-0005).</summary>
internal static class Envelopes
{
    internal static PathHop Member(string name) => PathHop.Member(name);
    public static PathHop At(int index) => PathHop.At(index);
    internal static PathHop Key(string key) => PathHop.ByKey(key);

    internal static RecordEditEnvelope SetAt(JsonElement value, params PathHop[] path) =>
        new(RecordEditEnvelope.Set, path, value);

    /// <summary>A set of JSON null: the member is cleared and reads as its default (ADR-0005).</summary>
    internal static RecordEditEnvelope Clear(params PathHop[] path) =>
        new(RecordEditEnvelope.Set, path, JsonDocument.Parse("null").RootElement);

    internal static RecordEditEnvelope AddAt(params PathHop[] path) => new(RecordEditEnvelope.Add, path);

    internal static RecordEditEnvelope AddAt(JsonElement element, params PathHop[] path) =>
        new(RecordEditEnvelope.Add, path, element);

    internal static RecordEditEnvelope RemoveAt(params PathHop[] path) => new(RecordEditEnvelope.Remove, path);

    internal static RecordEditEnvelope MoveTo(int destination, params PathHop[] path) =>
        new(RecordEditEnvelope.Move, path, JsonDocument.Parse(destination.ToString(System.Globalization.CultureInfo.InvariantCulture)).RootElement);

    /// <summary>A set of one top-level member: the gesture most tests make.</summary>
    internal static RecordEditResult Set(
        this EditRecordHandler handler, PluginKey plugin, string formKey, string member, JsonElement value) =>
        handler.Edit(plugin, formKey, SetAt(value, Member(member)));
}
