using System.Text.Json.Nodes;

namespace MEditService.Tests.RealData;

/// <summary>
/// Unconditional tests for the allowlist's normalizations. <see cref="SpriggitParityGateTests"/>
/// exercises these against the real tool, but it is environment-gated and skips by default; the
/// scoping properties below are the ones that would be expensive to discover from a gate failure, so
/// they are pinned here where they always run.
///
/// <para><b>An allowlist row is a licence to ignore a difference, so the thing worth testing is what a
/// row refuses to claim.</b> A row whose predicate is wider than its rationale silently converts
/// unrelated divergences into expected ones — and does so most damagingly at the moment a
/// <see cref="DivergenceTier.DeclaredUnobserved"/> row is promoted to
/// <see cref="DivergenceTier.Observed"/>, which for these rows is the Serialization 1.38.x bump the
/// allowlist exists to survive.</para>
/// </summary>
public sealed class SpriggitDivergenceAllowlistTests
{
    private static SpriggitDivergence Row(string name) =>
        SpriggitDivergenceAllowlist.Rows.Single(row => row.Name == name);

    private static JsonNode Normalized(string name, string json) =>
        Row(name).Normalize(JsonNode.Parse(json))!;

    [Fact]
    public void OmitUnusedConditionDataFields_DropsUnusedFieldsFromConditionDataObjects()
    {
        var normalized = Normalized(
            "OmitUnusedConditionDataFields",
            """
            {
              "MutagenObjectType": "FunctionConditionData",
              "Function": "GetInCurrentLocation",
              "UnusedPadding": 12
            }
            """);

        Assert.Null(normalized["UnusedPadding"]);
        Assert.Equal("GetInCurrentLocation", normalized["Function"]!.GetValue<string>());
    }

    /// <summary>
    /// The rival this row's scoping exists to defeat: a bare
    /// <c>key.Contains("unused")</c> predicate over the whole document. <c>Quest.UnusedConditions</c> is
    /// a real <c>ExtendedList&lt;Condition&gt;</c> and <c>Worldspace.UnusedWorldspaceParent</c> a real
    /// <c>FormLink</c> — legacy Creation Kit names for fields that carry data, not padding — so a wide
    /// predicate would let this row claim genuine divergences in them.
    /// </summary>
    [Fact]
    public void OmitUnusedConditionDataFields_LeavesUnusedNamedGameplayFieldsAlone()
    {
        var normalized = Normalized(
            "OmitUnusedConditionDataFields",
            """
            {
              "EditorID": "SomeQuest",
              "UnusedConditions": [ { "MutagenObjectType": "ConditionFloat" } ],
              "UnusedWorldspaceParent": "000800:Fallout4.esm"
            }
            """);

        Assert.NotNull(normalized["UnusedConditions"]);
        Assert.Equal("000800:Fallout4.esm", normalized["UnusedWorldspaceParent"]!.GetValue<string>());
    }

    /// <summary>
    /// An object with no discriminator is left alone rather than guessed at. Condition data always
    /// carries one (<c>IConditionData</c> is abstract), so declining to strip here costs nothing real
    /// and keeps over-removal — the failure mode that would let this row swallow a divergence — off the
    /// table entirely.
    /// </summary>
    [Fact]
    public void OmitUnusedConditionDataFields_LeavesUndiscriminatedObjectsAlone()
    {
        var normalized = Normalized("OmitUnusedConditionDataFields", """{ "Unused": 3 }""");

        Assert.Equal(3, normalized["Unused"]!.GetValue<int>());
    }

    [Fact]
    public void DefaultValuedMemberSkipping_DropsStatsVersionAndTheStatsObjectItEmpties()
    {
        var normalized = Normalized(
            "DefaultValuedMemberSkipping",
            """{ "ModHeader": { "Author": "mEdit", "Stats": { "Version": 1.0 } } }""");

        Assert.Null(normalized["ModHeader"]!["Stats"]);
        Assert.Equal("mEdit", normalized["ModHeader"]!["Author"]!.GetValue<string>());
    }

    /// <summary>
    /// Scoped as narrowly as its evidence: a <c>Version</c> that is not the mod header's stats version
    /// is not this row's business, and a <c>Stats</c> object with anything else left in it survives.
    /// </summary>
    [Fact]
    public void DefaultValuedMemberSkipping_LeavesOtherVersionFieldsAndNonEmptyStatsAlone()
    {
        var normalized = Normalized(
            "DefaultValuedMemberSkipping",
            """{ "Version": 1.0, "Stats": { "Version": 1.0, "NumRecords": 7 } }""");

        Assert.Equal(1.0, normalized["Version"]!.GetValue<double>());
        Assert.Equal(7, normalized["Stats"]!["NumRecords"]!.GetValue<int>());
        Assert.Null(normalized["Stats"]!["Version"]);
    }

    [Fact]
    public void OmitUnknownGroupData_DropsExactlyTheThreeNamesUpstreamDrops()
    {
        var normalized = Normalized(
            "OmitUnknownGroupData",
            """
            {
              "UnknownGroupData": 1,
              "PersistentUnknownGroupData": 2,
              "TemporaryUnknownGroupData": 3,
              "SomeOtherUnknownData": 4
            }
            """);

        Assert.Null(normalized["UnknownGroupData"]);
        Assert.Null(normalized["PersistentUnknownGroupData"]);
        Assert.Null(normalized["TemporaryUnknownGroupData"]);
        Assert.Equal(4, normalized["SomeOtherUnknownData"]!.GetValue<int>());
    }

    /// <summary>
    /// <c>SortList</c> erases order and nothing else — a value difference inside a list survives it, so
    /// the widest row on the allowlist still cannot excuse a content change.
    /// </summary>
    [Fact]
    public void SortList_ErasesOrderWithoutErasingContent()
    {
        var reordered = Normalized("SortList", """{ "Items": [ "b", "a" ] }""");
        var inOrder = Normalized("SortList", """{ "Items": [ "a", "b" ] }""");
        var changed = Normalized("SortList", """{ "Items": [ "a", "c" ] }""");

        Assert.True(JsonNode.DeepEquals(reordered, inOrder));
        Assert.False(JsonNode.DeepEquals(reordered, changed));
    }
}
