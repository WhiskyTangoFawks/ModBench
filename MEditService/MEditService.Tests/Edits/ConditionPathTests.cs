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

    // TryParseNestedFieldPath moved from ConditionPath (Edits/) into Fallout4ConditionCodec
    // (Schema/) as part of #184: IConditionCodec.IsNestedConditionListField now takes the raw
    // composed field path directly and does its own arbitrary-depth parsing internally, since no
    // production caller ever needed the parsed pieces themselves. See
    // Fallout4ConditionCodecTests.IsNestedConditionListField_* for the parsing/shape coverage that
    // used to live here.
}
