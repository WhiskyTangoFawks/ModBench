namespace MEditService.Codec.Schema;

/// <summary>A link no one could check because the plugin it names could not be read, and that plugin.</summary>
public readonly record struct UncheckedLink(string Plugin, string Message);

/// <summary>The words for what could not be checked because a plugin could not be read (ADR-0019): a file
/// nothing could be read from answers nothing about the links into it.</summary>
public static class UncheckedLinks
{
    /// <summary>Null when the plugin <paramref name="formKey"/> names was read.</summary>
    public static UncheckedLink? Of(string formKey, IReadOnlyDictionary<string, string> unreadableByName) =>
        RecordMasters.PluginNamedBy(formKey) is { } owner && unreadableByName.TryGetValue(owner, out var reason)
            ? new UncheckedLink(owner, $"{owner} could not be read, so this link was not checked: {reason}")
            : null;

    public static string NoLinkInto(string fileName, string reason) =>
        $"{fileName} is in the load order but could not be read, so no link into it was checked: {reason}";
}
