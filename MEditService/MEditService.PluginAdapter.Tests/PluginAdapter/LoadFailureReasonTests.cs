namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class LoadFailureReasonTests
{
    [Fact]
    public void TheReason_NamesEveryExceptionOfTheChain_ItsTypeAndMessage_OutermostFirst()
    {
        var outer = new InvalidOperationException("outer boom", new FormatException("inner boom"));

        Assert.Equal("InvalidOperationException: outer boom\nFormatException: inner boom", LoadFailureReason.Of(outer));
    }
}
