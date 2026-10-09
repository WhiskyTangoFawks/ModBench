namespace MEditService.Codec.Schema;

/// <summary>A record's EditorID as its node holds it: none, a string, or a node that is no string.
/// Reading the EditorID of the last throws, so no reader takes it for none.</summary>
public readonly struct EditorIdRead
{
    private readonly string? _editorId;

    private EditorIdRead(string? editorId, string? whyUnreadable) => (_editorId, WhyUnreadable) = (editorId, whyUnreadable);

    internal static EditorIdRead None => default;

    internal static EditorIdRead Of(string editorId) => new(editorId, null);

    internal static EditorIdRead Unreadable(string why) => new(null, why);

    public string? WhyUnreadable { get; }

    public string? EditorId => WhyUnreadable is { } why ? throw new InvalidOperationException($"The record's {why}.") : _editorId;
}
