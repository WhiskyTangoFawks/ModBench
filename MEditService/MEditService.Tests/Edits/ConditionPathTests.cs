using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

public sealed class ConditionPathTests
{
    [Fact]
    public void TryParse_ValidScalarPath_ReturnsFieldPathIndexAndSubField()
    {
        var ok = ConditionPath.TryParse(@"CTDA\Conditions\0\Function", out var fieldPath, out var index, out var subField);
        Assert.True(ok);
        Assert.Equal("Conditions", fieldPath);
        Assert.Equal(0, index);
        Assert.Equal("Function", subField);
    }

    [Fact]
    public void TryParse_ParameterSubField_KeepsEmbeddedBackslashInSubField()
    {
        var ok = ConditionPath.TryParse(@"CTDA\Conditions\2\Parameter\1", out var fieldPath, out var index, out var subField);
        Assert.True(ok);
        Assert.Equal("Conditions", fieldPath);
        Assert.Equal(2, index);
        Assert.Equal(@"Parameter\1", subField);
    }

    [Fact]
    public void TryParse_NonConditionPrefix_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParse(@"VMAD\Script\Prop", out _, out _, out _));
    }

    [Fact]
    public void TryParse_NonNumericIndex_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParse(@"CTDA\Conditions\zero\Function", out _, out _, out _));
    }

    [Fact]
    public void TryParse_NegativeIndex_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParse(@"CTDA\Conditions\-1\Function", out _, out _, out _));
    }

    [Fact]
    public void TryParse_MissingSubField_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParse(@"CTDA\Conditions\0", out _, out _, out _));
    }

    [Fact]
    public void TryParse_EmptyFieldPath_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParse(@"CTDA\\0\Function", out _, out _, out _));
    }

    [Fact]
    public void Build_RoundTripsThroughTryParse()
    {
        var path = ConditionPath.Build("Conditions", 3, "RunOn");
        var ok = ConditionPath.TryParse(path, out var fieldPath, out var index, out var subField);
        Assert.True(ok);
        Assert.Equal("Conditions", fieldPath);
        Assert.Equal(3, index);
        Assert.Equal("RunOn", subField);
    }

    [Fact]
    public void BuildParameter_RoundTripsAndParsesAsParameterIndex()
    {
        var path = ConditionPath.BuildParameter("Conditions", 0, 1);
        Assert.True(ConditionPath.TryParse(path, out _, out _, out var subField));
        Assert.True(ConditionPath.TryParseParameterIndex(subField, out var paramIndex));
        Assert.Equal(1, paramIndex);
    }

    [Fact]
    public void TryParseParameterIndex_NonParameterSubField_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseParameterIndex("Function", out _));
    }

    // ---- TryParseNestedFieldPath (#182): splits a composed conditionFieldPath segment
    // ("Effects[2].Conditions") into the enclosing array's property name/index and the nested
    // condition-list property name. Pure string parsing — no reflection, no CLR type. ----

    [Fact]
    public void TryParseNestedFieldPath_ValidOneLevelPath_ReturnsArrayPropIndexAndNestedField()
    {
        var ok = ConditionPath.TryParseNestedFieldPath(
            "Effects[2].Conditions", out var arrayProp, out var arrayIndex, out var nestedField);
        Assert.True(ok);
        Assert.Equal("Effects", arrayProp);
        Assert.Equal(2, arrayIndex);
        Assert.Equal("Conditions", nestedField);
    }

    [Fact]
    public void TryParseNestedFieldPath_FlatPathWithNoBracket_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Conditions", out _, out _, out _));
    }

    [Fact]
    public void TryParseNestedFieldPath_UnbalancedBracket_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Effects[2.Conditions", out _, out _, out _));
    }

    [Fact]
    public void TryParseNestedFieldPath_NonNumericIndex_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Effects[abc].Conditions", out _, out _, out _));
    }

    [Fact]
    public void TryParseNestedFieldPath_NegativeIndex_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Effects[-1].Conditions", out _, out _, out _));
    }

    [Fact]
    public void TryParseNestedFieldPath_MissingDotAfterBracket_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Effects[2]Conditions", out _, out _, out _));
    }

    [Fact]
    public void TryParseNestedFieldPath_EmptyNestedField_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Effects[2].", out _, out _, out _));
    }

    // Two-level nesting (Perk.Effects[i].Conditions[j].Conditions) is #184's scope, not #182's —
    // a nestedField that itself carries another bracket must not be silently accepted here.
    [Fact]
    public void TryParseNestedFieldPath_TwoLevelNestedField_ReturnsFalse()
    {
        Assert.False(ConditionPath.TryParseNestedFieldPath(
            "Effects[2].Conditions[1].Conditions", out _, out _, out _));
    }

    [Fact]
    public void TryParseNestedFieldPath_DoubleDigitIndex_ParsesCorrectly()
    {
        var ok = ConditionPath.TryParseNestedFieldPath(
            "Effects[10].Conditions", out var arrayProp, out var arrayIndex, out var nestedField);
        Assert.True(ok);
        Assert.Equal("Effects", arrayProp);
        Assert.Equal(10, arrayIndex);
        Assert.Equal("Conditions", nestedField);
    }
}
