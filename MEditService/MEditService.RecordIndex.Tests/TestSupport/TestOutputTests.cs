using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.RecordIndex.Tests.TestSupport;

public sealed class TestOutputTests
{
    private sealed class RecordingBus : IMessageBus
    {
        internal List<IMessageSinkMessage> Queued { get; } = [];

        public bool QueueMessage(IMessageSinkMessage message)
        {
            Queued.Add(message);
            return true;
        }

        public void Dispose() { }
    }

    private static XunitTestCase ThisTestCase()
    {
        var type = typeof(TestOutputTests);
        var testClass = new TestClass(new TestCollection(new TestAssembly(Reflector.Wrap(type.Assembly)), null, "the collection"), Reflector.Wrap(type));
        var method = new TestMethod(testClass, Reflector.Wrap(type.GetMethod(nameof(AWarningLoggedDuringATest_ThroughTheContainerOrSerilogsStaticLog_IsInThatTestsOutput)).Require()));
        return new XunitTestCase(new NullMessageSink(), TestMethodDisplay.ClassAndMethod, TestMethodDisplayOptions.None, method);
    }

    public static TheoryData<Func<ITest, ITestResultMessage>> Results => new()
    {
        test => new TestPassed(test, 0, "Written by the test\n"),
        test => new TestFailed(test, 0, "Written by the test\n", ["FailException"], ["Failed"], ["at the test"], [-1]),
    };

    [Theory]
    [MemberData(nameof(Results))]
    public void AWarningLoggedDuringATest_ThroughTheContainerOrSerilogsStaticLog_IsInThatTestsOutput(Func<ITest, ITestResultMessage> result)
    {
        using var bus = new RecordingBus();
        var sink = new TestOutputSink(bus);
        using var testCase = ThisTestCase();
        var test = new XunitTest(testCase, "the logging test");
        sink.OnMessage(new TestStarting(test));

        using (var container = Indexes.Container(new LoadOrderHolder()))
            container.GetRequiredService<ILogger<TestOutputTests>>().LogWarning("Warned through the container");
        Log.Warning("Warned through Serilog");
        sink.OnMessage(result(test));

        var output = Assert.IsAssignableFrom<ITestResultMessage>(bus.Queued.Last()).Output;
        Assert.Contains("Written by the test", output, StringComparison.Ordinal);
        Assert.Contains("Warned through the container", output, StringComparison.Ordinal);
        Assert.Contains("Warned through Serilog", output, StringComparison.Ordinal);
    }
}
