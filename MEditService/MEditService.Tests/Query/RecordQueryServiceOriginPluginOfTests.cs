using MEditService.Core.Queries;

namespace MEditService.Tests.Query;

/// <summary>
/// Direct unit tests for <see cref="RecordQueryService.OriginPluginOf"/> — the plugin substring of
/// a "FormID:Plugin" FormKey string, used by GetEffectiveMasters (#336/ADR-0038) to find which
/// plugins a staged record's own FormKey and its FormLink content originate from. Restores the
/// edge-case coverage <c>EditOrchestratorOriginPluginOfTests.cs</c> pinned pre-#336 for the
/// then-only copy — deleted with that copy, not with the parsing logic itself, which survives
/// here.
/// </summary>
public sealed class RecordQueryServiceOriginPluginOfTests
{
    [Fact]
    public void OriginPluginOf_WellFormedFormKey_ReturnsPlugin()
    {
        Assert.Equal("Fallout4.esm", RecordQueryService.OriginPluginOf("000001:Fallout4.esm"));
    }

    [Fact]
    public void OriginPluginOf_NoColon_ReturnsNull()
    {
        Assert.Null(RecordQueryService.OriginPluginOf("NoColonHere"));
    }

    [Fact]
    public void OriginPluginOf_ColonIsLastCharacter_ReturnsNull()
    {
        Assert.Null(RecordQueryService.OriginPluginOf("000001:"));
    }

    [Fact]
    public void OriginPluginOf_EmptyString_ReturnsNull()
    {
        Assert.Null(RecordQueryService.OriginPluginOf(""));
    }

    [Fact]
    public void OriginPluginOf_ColonAtStart_ReturnsSubstringAfterIt()
    {
        // Distinguishes `colon >= 0` from `colon > 0` — an empty local-id prefix is still a
        // well-formed (if degenerate) split, not a malformed FormKey.
        Assert.Equal("Plugin.esp", RecordQueryService.OriginPluginOf(":Plugin.esp"));
    }
}
