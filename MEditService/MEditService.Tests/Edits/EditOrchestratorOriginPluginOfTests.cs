using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

/// <summary>
/// Direct unit tests for <see cref="EditOrchestrator.OriginPluginOf"/> (issue #86) — the plugin
/// substring of a "FormID:Plugin" FormKey string, used by the copy-to auto-add-master path to find
/// which plugins a copied record's own FormKey and its FormLink content originate from.
/// </summary>
public sealed class EditOrchestratorOriginPluginOfTests
{
    [Fact]
    public void OriginPluginOf_WellFormedFormKey_ReturnsPlugin()
    {
        Assert.Equal("Fallout4.esm", EditOrchestrator.OriginPluginOf("000001:Fallout4.esm"));
    }

    [Fact]
    public void OriginPluginOf_NoColon_ReturnsNull()
    {
        Assert.Null(EditOrchestrator.OriginPluginOf("NoColonHere"));
    }

    [Fact]
    public void OriginPluginOf_ColonIsLastCharacter_ReturnsNull()
    {
        Assert.Null(EditOrchestrator.OriginPluginOf("000001:"));
    }

    [Fact]
    public void OriginPluginOf_EmptyString_ReturnsNull()
    {
        Assert.Null(EditOrchestrator.OriginPluginOf(""));
    }

    [Fact]
    public void OriginPluginOf_ColonAtStart_ReturnsSubstringAfterIt()
    {
        // Distinguishes `colon >= 0` from `colon > 0` — an empty local-id prefix is still a
        // well-formed (if degenerate) split, not a malformed FormKey.
        Assert.Equal("Plugin.esp", EditOrchestrator.OriginPluginOf(":Plugin.esp"));
    }
}
