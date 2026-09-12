using System.Text.RegularExpressions;

namespace MEditService.Codec.Schema;

/// <summary>A concrete leaf's label relative to its Loqui union base: a pure function of two type
/// names, so it holds for any game's assembly.</summary>
internal static partial class LeafLabel
{
    /// <summary><c>QuestReferenceAlias</c> under <c>AQuestAlias</c> is "Reference": words the base
    /// shares are dropped from both ends. A leaf that strips to nothing keeps its name, spaced;
    /// an empty label is a choice nobody can pick.</summary>
    public static string For(string abstractBaseName, string leafClassName)
    {
        var baseWords = Words(StripLoquiAbstractPrefix(abstractBaseName));
        var leafWords = Words(leafClassName);

        var start = 0;
        while (start < leafWords.Count && start < baseWords.Count
            && string.Equals(leafWords[start], baseWords[start], StringComparison.Ordinal)) start++;

        var end = leafWords.Count;
        var baseEnd = baseWords.Count;
        while (end > start && baseEnd > start
            && string.Equals(leafWords[end - 1], baseWords[baseEnd - 1], StringComparison.Ordinal))
        {
            end--;
            baseEnd--;
        }

        var distinguishing = leafWords.GetRange(start, end - start);
        return string.Join(' ', distinguishing.Count > 0 ? distinguishing : leafWords);
    }

    /// <summary>The class's own word in a document type name: a nested class's declaring type and a
    /// generic's arguments (<c>Outer+Inner</c>, <c>ObjectModIntProperty&lt;Armor+Property&gt;</c>)
    /// distinguish nothing a label needs.</summary>
    public static string ClassWord(string documentTypeName)
    {
        var generic = documentTypeName.IndexOf('<', StringComparison.Ordinal);
        var name = generic < 0 ? documentTypeName : documentTypeName[..generic];
        var nested = name.LastIndexOf('+');
        return nested < 0 ? name : name[(nested + 1)..];
    }

    // Mutagen's own "A<Name>" spelling for an abstract Loqui base (ANpcLevel, AQuestAlias). A base
    // not spelled that way keeps its whole name, and the comparison above finds less in common.
    private static string StripLoquiAbstractPrefix(string name) =>
        name.Length > 1 && name[0] == 'A' && char.IsUpper(name[1]) ? name[1..] : name;

    private static List<string> Words(string name) =>
        [.. WordBoundary().Split(name).Where(w => w.Length > 0)];

    // Splits PascalCase without touching case, so an acronym survives: "NPCData" is "NPC Data".
    [GeneratedRegex("(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")]
    private static partial Regex WordBoundary();
}
