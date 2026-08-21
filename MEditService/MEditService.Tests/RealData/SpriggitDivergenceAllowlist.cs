using System.Text.Json.Nodes;

namespace MEditService.Tests.RealData;

/// <summary>Whether a divergence is expected to be visible on the fixture, or merely declared.</summary>
internal enum DivergenceTier
{
    /// <summary>Must be observed at least once. A row that stops being necessary is either a genuine
    /// convergence (delete the row) or an upstream change that silently moved (investigate) — either
    /// way the gate should make someone look.</summary>
    Observed,

    /// <summary>Must be observed <b>zero</b> times. Real in upstream Spriggit but not reachable by this
    /// fixture, so "assert it is present" is unsatisfiable; asserting its absence still catches the
    /// case where an upstream change makes it appear.</summary>
    DeclaredUnobserved,
}

/// <summary>
/// One named, pinned divergence between our tree and real Spriggit's.
///
/// <para><see cref="Normalize"/> is applied to <b>both</b> sides, which keeps every row symmetric and
/// composable: removing a key Spriggit already omits is a no-op on their side, and sorting a list is
/// meaningful on both. A file is explained when normalizing by the whole allowlist makes the two
/// documents deep-equal; a row is <i>necessary</i> for that file when dropping it alone breaks the
/// explanation. Necessity — not membership — is what <see cref="DivergenceTier.Observed"/> counts.</para>
/// </summary>
internal sealed record SpriggitDivergence(
    string Name,
    string Rationale,
    string ClosesAt,
    DivergenceTier Tier,
    Func<JsonNode?, JsonNode?> Normalize);

/// <summary>
/// The pinned allowlist of named divergences between the tree Modbench writes and the tree real
/// Spriggit writes — #455, and the drift-prevention mechanism for the replicated ~80-line convention
/// layer that ADR-0041's #444 amendment chose over a code dependency.
///
/// <para><b>The allowlist going empty is #444's convergence trigger</b>, at which point the
/// package-dependency question re-opens as a new issue. That is why a row is a liability, not a
/// license: every row is a reason we are not yet byte-identical to the specification, annotated with
/// what would close it. Rows are only ever added with a named upstream cause.</para>
///
/// <para><b>Rows are a table on purpose.</b> #459 (folder-split child order carries no ordinal, which
/// for FO4 <c>DialogTopic.Responses</c> is semantic loss) is unresolved, and one candidate resolution
/// writes <c>"[N] "</c> filename prefixes for <c>Responses/</c> children only — itself a named parity
/// divergence. Resolving it should be one added row here, not a rewrite of the gate.</para>
/// </summary>
internal static class SpriggitDivergenceAllowlist
{
    /// <summary>Shared annotation for the three rows that are all waiting on the same thing.</summary>
    private const string ClosesAtSerializationBump =
        "Serialization 1.38.x bump, gated on the Mutagen 0.54 ObjectTemplate regression (#385)";

    /// <summary>Exactly the three names <c>OmitUnknownGroupData</c> suppresses.</summary>
    private static readonly HashSet<string> UnknownGroupDataFields = new(StringComparer.Ordinal)
    {
        "UnknownGroupData",
        "PersistentUnknownGroupData",
        "TemporaryUnknownGroupData",
    };

    internal static IReadOnlyList<SpriggitDivergence> Rows { get; } =
    [
        new SpriggitDivergence(
            Name: "SortList",
            Rationale:
                "Spriggit's Fallout 4 package applies SortList across at least nine customization "
                + "classes — Race.{MovementTypeNames,Attacks}, ScriptEntry.Properties, "
                + "VirtualMachineAdapter.Scripts, Npc.{ActorEffect,Factions,Items,Attacks}, "
                + "Cell.{Persistent,Temporary}, ImpactDataSet.Impacts, Perk.Effects, "
                + "QuestAdapter.Fragments and four Location lists — giving CK-shuffled lists a "
                + "deterministic order. SortList is a Serialization 1.38.x feature, absent from this "
                + "project's 1.37.1 pin, so our lists keep their on-disk order. Named for the feature, "
                + "not for one symptom: cell child ordering is a small minority of the affected files.",
            ClosesAt: ClosesAtSerializationBump,
            Tier: DivergenceTier.Observed,
            Normalize: SortEveryArray),

        new SpriggitDivergence(
            Name: "OmitUnknownGroupData",
            Rationale:
                "Spriggit's overall Customization calls OmitUnknownGroupData(), which drops exactly "
                + "UnknownGroupData / PersistentUnknownGroupData / TemporaryUnknownGroupData "
                + "(CustomizationDriver.cs in the 1.38.6 clone, read at implementation — not inferred "
                + "from the method name). A 1.38.x feature absent from our 1.37.1 pin, so we emit them.",
            ClosesAt: ClosesAtSerializationBump,
            Tier: DivergenceTier.Observed,
            Normalize: node => RemoveKeys(node, UnknownGroupDataFields.Contains)),

        new SpriggitDivergence(
            Name: "OmitUnusedConditionDataFields",
            Rationale:
                "Spriggit's overall Customization also calls OmitUnusedConditionDataFields(), which "
                + "drops fields whose name contains \"unused\" from objects whose type name contains "
                + "\"ConditionData\" (same source). A 1.38.x feature absent from our pin. Declared "
                + "rather than observed: the committed fixture's conditions carry no such field, proved "
                + "by count — stripping Condition.Unknown1 alone made all 981 condition-bearing files "
                + "exactly equal before that omission was adopted. Asserting zero still catches an "
                + "upstream change that makes it appear.\n"
                + "The enclosing-object scope is load-bearing, not decoration. \"Unused\" names real "
                + "gameplay fields elsewhere in Fallout 4 — Quest.UnusedConditions is an "
                + "ExtendedList<Condition> and Worldspace.UnusedWorldspaceParent is a live FormLink, "
                + "both legacy Creation Kit names for fields that carry data — so a predicate matching "
                + "the bare key name anywhere in the document would claim divergences in fields this row "
                + "has nothing to do with. Today that would surface as a red gate with a wrong diagnosis, "
                + "since the row asserts zero; at the 1.38.x bump, when this row is promoted to Observed, "
                + "it would become a hiding place instead — and surviving that bump is what the allowlist "
                + "is for.",
            ClosesAt: ClosesAtSerializationBump,
            Tier: DivergenceTier.DeclaredUnobserved,
            Normalize: RemoveUnusedConditionDataFields),

        new SpriggitDivergence(
            Name: "DefaultValuedMemberSkipping",
            Rationale:
                "Serialization 1.38.x omits a member whose value equals its default; 1.37.1 writes it. "
                + "Established by experiment rather than inferred from a version diff: two synthetic "
                + "plugins differing only in ModHeader.Stats.Version (1.0, the default, and 1.5) were "
                + "serialized through both doors — the oracle wrote no Stats object at all for 1.0 and "
                + "\"Stats\": { \"Version\": 1.5 } for 1.5, while our door wrote Version in both cases. "
                + "Not a customization on either side: nothing in Spriggit's Customization or its "
                + "Customizations/Omit set touches ModStats.Version (CustomizationDriver's "
                + "OmitLastModifiedData covers the single name \"LastModified\"). Scoped deliberately "
                + "narrowly to Stats.Version, the only place the committed fixture surfaces it — an "
                + "allowlist row wide enough to swallow every default-valued member would be a place "
                + "for real divergences to hide. If a future fixture surfaces more, this row goes red "
                + "and someone widens it on purpose.",
            ClosesAt: ClosesAtSerializationBump,
            Tier: DivergenceTier.Observed,
            Normalize: RemoveStatsVersion),
    ];

    /// <summary>
    /// Drops <c>Version</c> from any object held under a <c>Stats</c> key, at any depth — and drops the
    /// <c>Stats</c> key itself if that empties it, because the skipping is what the oracle does too: it
    /// writes no <c>Stats</c> object at all rather than an empty one.
    /// </summary>
    private static JsonNode? RemoveStatsVersion(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var mapped = new JsonObject();
                foreach (var (key, value) in obj)
                {
                    var cloned = RemoveStatsVersion(value?.DeepClone());
                    if (key == "Stats" && cloned is JsonObject stats)
                    {
                        stats.Remove("Version");
                        if (stats.Count == 0) continue;
                    }
                    mapped[key] = cloned;
                }
                return mapped;
            case JsonArray array:
                var items = new JsonArray();
                foreach (var item in array) items.Add(RemoveStatsVersion(item?.DeepClone()));
                return items;
            default:
                return node?.DeepClone();
        }
    }

    /// <summary>
    /// Drops properties whose name contains "unused" <b>only from objects that are condition data</b> —
    /// mirroring the upstream rule exactly (<c>CustomizationDriver.WrapOmission</c>: the declaring
    /// object's type name must contain <c>ConditionData</c> and the property name must contain
    /// <c>unused</c>, both case-handled as here).
    ///
    /// <para>The object's type is read from the <c>MutagenObjectType</c> discriminator, which condition
    /// data always carries because <c>IConditionData</c> is abstract — the kernel writes a discriminator
    /// exactly when the element type is ambiguous. An object with no discriminator is left alone rather
    /// than guessed at: over-removal is the failure mode that matters here, since it would let a real
    /// divergence be claimed by this row.</para>
    /// </summary>
    private static JsonNode? RemoveUnusedConditionDataFields(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var isConditionData = obj["MutagenObjectType"]?.GetValue<string>()
                    .Contains("ConditionData", StringComparison.Ordinal) == true;
                var mapped = new JsonObject();
                foreach (var (key, value) in obj)
                {
                    if (isConditionData && key.Contains("unused", StringComparison.OrdinalIgnoreCase)) continue;
                    mapped[key] = RemoveUnusedConditionDataFields(value?.DeepClone());
                }
                return mapped;
            case JsonArray array:
                var items = new JsonArray();
                foreach (var item in array) items.Add(RemoveUnusedConditionDataFields(item?.DeepClone()));
                return items;
            default:
                return node?.DeepClone();
        }
    }

    /// <summary>Recursively drops every property whose name satisfies <paramref name="shouldRemove"/>.</summary>
    private static JsonNode? RemoveKeys(JsonNode? node, Func<string, bool> shouldRemove)
    {
        switch (node)
        {
            case JsonObject obj:
                var mapped = new JsonObject();
                foreach (var (key, value) in obj)
                {
                    if (shouldRemove(key)) continue;
                    mapped[key] = RemoveKeys(value?.DeepClone(), shouldRemove);
                }
                return mapped;
            case JsonArray array:
                var items = new JsonArray();
                foreach (var item in array) items.Add(RemoveKeys(item?.DeepClone(), shouldRemove));
                return items;
            default:
                return node?.DeepClone();
        }
    }

    /// <summary>
    /// Recursively reorders every array into a canonical order (each element's own serialized text),
    /// which makes order-only differences invisible and nothing else. Deliberately blunt: it erases
    /// list order everywhere rather than only in the lists Spriggit sorts, so it is the widest row on
    /// the list and the one whose closure buys the most.
    /// </summary>
    private static JsonNode? SortEveryArray(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var mapped = new JsonObject();
                foreach (var (key, value) in obj) mapped[key] = SortEveryArray(value?.DeepClone());
                return mapped;
            case JsonArray array:
                var sorted = array
                    .Select(item => SortEveryArray(item?.DeepClone()))
                    .OrderBy(item => item?.ToJsonString() ?? string.Empty, StringComparer.Ordinal)
                    .ToList();
                var result = new JsonArray();
                foreach (var item in sorted) result.Add(item);
                return result;
            default:
                return node?.DeepClone();
        }
    }
}
