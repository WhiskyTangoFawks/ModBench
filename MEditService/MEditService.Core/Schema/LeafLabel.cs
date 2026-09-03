using System.Text.RegularExpressions;

namespace MEditService.Core.Schema;

/// <summary>
/// What an abstract Loqui union's concrete leaf is called, once the union it belongs to is known.
/// A pure function of two type names — no game knowledge, no table — so it holds for any game's
/// Mutagen assembly. <c>RecordDisplayNames</c>' counterpart for the types a record type contains.
/// </summary>
public static partial class LeafLabel
{
    /// <summary>
    /// <c>QuestReferenceAlias</c> under <c>AQuestAlias</c> is "Reference": the base's own words are
    /// what every sibling shares, so dropping them from the head and the tail of the leaf's leaves
    /// what distinguishes it.
    ///
    /// <para>A leaf that <i>is</i> its base (<c>NpcLevel</c> under <c>ANpcLevel</c>) strips to
    /// nothing and keeps its own name, spaced — an empty label is a choice nobody can pick.</para>
    /// </summary>
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

    // Mutagen's own "A<Name>" spelling for an abstract Loqui base (ANpcLevel, AQuestAlias). A base
    // not spelled that way keeps its whole name, and the comparison above finds less in common.
    private static string StripLoquiAbstractPrefix(string name) =>
        name.Length > 1 && name[0] == 'A' && char.IsUpper(name[1]) ? name[1..] : name;

    private static List<string> Words(string name) =>
        [.. WordBoundary().Split(name).Where(w => w.Length > 0)];

    // Splits PascalCase at a word boundary while leaving the casing alone, so an acronym survives
    // as itself: "NPCData" is "NPC Data", not "Npcdata". Two boundaries — a capital after a
    // lowercase or digit, and the last capital of a run that starts a new word.
    [GeneratedRegex("(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")]
    private static partial Regex WordBoundary();
}
