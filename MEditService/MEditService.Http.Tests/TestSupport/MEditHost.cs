using Microsoft.AspNetCore.Mvc.Testing;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>The whole service, hosted in process.</summary>
public sealed class MEditHost : WebApplicationFactory<Program>;
