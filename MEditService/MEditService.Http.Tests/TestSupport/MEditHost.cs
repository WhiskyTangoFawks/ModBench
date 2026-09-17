using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Tests.TestSupport;

/// <summary>The whole service, hosted in process.</summary>
public sealed class MEditHost : WebApplicationFactory<Program>;
